//! SendInput INPUT-struct serialization — the pure ABI layer (W3).
//!
//! SendInput takes an array of INPUT structs `{ DWORD type; union u; }` — on
//! x64 the union (16 bytes) sits at offset 8 after 4 bytes of type + 4 of
//! padding, total 40 bytes. This module writes that byte layout by hand into
//! a little-endian Vec<u8> — union-free, version-stable, and EXACTLY the
//! layout the W1 koffi InputBuilder produced (verified by the byte-level
//! cargo tests below, which port the agent's win-parity-fixes B1 pins: the
//! two's-complement wheel encoding, the scancode keyboard fields, and the
//! 40-byte stride).
//!
//! WHEEL NOTE (the W1 B1 lesson, ported): mouseData is a DWORD field but
//! callers legitimately pass NEGATIVE values — wheel-down is
//! `notches * WHEEL_DELTA` (e.g. -360). Two's complement is the correct
//! DWORD encoding; never range-check-and-reject (the koffi era threw
//! ERR_OUT_OF_RANGE on every scroll-down).

/// INPUT.type values (WinUser.h).
pub const INPUT_MOUSE: u32 = 0;
pub const INPUT_KEYBOARD: u32 = 1;

/// dwFlags (WinUser.h) — the subset the helper uses.
pub const MOUSEEVENTF_MOVE: u32 = 0x0001;
pub const MOUSEEVENTF_LEFTDOWN: u32 = 0x0002;
pub const MOUSEEVENTF_LEFTUP: u32 = 0x0004;
pub const MOUSEEVENTF_RIGHTDOWN: u32 = 0x0008;
pub const MOUSEEVENTF_RIGHTUP: u32 = 0x0010;
pub const MOUSEEVENTF_WHEEL: u32 = 0x0800;
pub const MOUSEEVENTF_ABSOLUTE: u32 = 0x8000;
/// With ABSOLUTE: normalize 0..65535 across the ENTIRE virtual screen, not
/// just the primary monitor — required for multi-monitor correctness.
pub const MOUSEEVENTF_VIRTUALDESK: u32 = 0x4000;
pub const WHEEL_DELTA: i32 = 120;

pub const KEYEVENTF_EXTENDEDKEY: u32 = 0x0001;
pub const KEYEVENTF_KEYUP: u32 = 0x0002;
pub const KEYEVENTF_UNICODE: u32 = 0x0004;
pub const KEYEVENTF_SCANCODE: u32 = 0x0008;

/// sizeof(INPUT) on x64: 4 (type) + 4 (pad) + 16 (union) + 16 (pad) = 40.
pub const INPUT_SIZE: usize = 40;

/// A planned key event in the helper's own terms (vk + scan + extended +
/// shift — the WinKeySpec contract the agent plans in win-platform.ts).
#[derive(Debug, Clone, PartialEq)]
pub struct KeySpec {
    pub vk: u16,
    pub scan: u16,
    pub shift: bool,
    pub extended: bool,
}

/// The pure INPUT-struct serializer. `Send` (a plain buffer) so the Windows
/// caller can build on any thread.
#[derive(Debug, Default)]
pub struct InputBuilder {
    buf: Vec<u8>,
}

impl InputBuilder {
    pub fn new() -> Self {
        Self { buf: Vec::new() }
    }

    fn push_header(&mut self, kind: u32) -> usize {
        let o = self.buf.len();
        self.buf.resize(o + INPUT_SIZE, 0);
        self.buf[o..o + 4].copy_from_slice(&kind.to_le_bytes());
        o
    }

    /// MOUSEINPUT: dx, dy, mouseData, dwFlags (time/extra = 0).
    /// mouseData takes i32: the two's-complement DWORD encoding for wheel
    /// deltas is applied HERE (W1 B1).
    pub fn mouse(&mut self, dx: i32, dy: i32, mouse_data: i32, dw_flags: u32) -> &mut Self {
        let o = self.push_header(INPUT_MOUSE);
        self.buf[o + 8..o + 12].copy_from_slice(&dx.to_le_bytes());
        self.buf[o + 12..o + 16].copy_from_slice(&dy.to_le_bytes());
        self.buf[o + 16..o + 20].copy_from_slice(&(mouse_data as u32).to_le_bytes());
        self.buf[o + 20..o + 24].copy_from_slice(&dw_flags.to_le_bytes());
        self
    }

    /// KEYBDINPUT: wVk, wScan, dwFlags (time/extra = 0).
    pub fn keyboard(&mut self, w_vk: u16, w_scan: u16, dw_flags: u32) -> &mut Self {
        let o = self.push_header(INPUT_KEYBOARD);
        self.buf[o + 8..o + 10].copy_from_slice(&w_vk.to_le_bytes());
        self.buf[o + 10..o + 12].copy_from_slice(&w_scan.to_le_bytes());
        self.buf[o + 12..o + 16].copy_from_slice(&dw_flags.to_le_bytes());
        self
    }

    pub fn len(&self) -> usize {
        self.buf.len() / INPUT_SIZE
    }

    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }

    pub fn bytes(&self) -> &[u8] {
        &self.buf
    }
}

/// Normalize an absolute virtual-screen coordinate to SendInput's
/// 0..65535 MOUSEEVENTF_ABSOLUTE|VIRTUALDESK space (pure — mirrors the W1
/// TS math exactly, including Math.round, so behavior is unchanged for
/// multi-monitor clicks).
pub fn normalize_absolute(x: i32, y: i32, vx: i32, vy: i32, vw: i32, vh: i32) -> (i32, i32) {
    let norm = |v: i32, origin: i32, span: i32| -> i32 {
        let span = (span.max(1) as i64 - 1).max(1) as f64;
        (((v - origin) as f64 * 65535.0) / span).round() as i32
    };
    (norm(x, vx, vw), norm(y, vy, vh))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The 40-byte INPUT layout (x64 ABI) — the pin that MOVED here from the
    /// agent's koffi-era TS tests (parent steer 2026-09-25): type at 0,
    /// union at 8, MOUSEINPUT {dx,dy,mouseData,dwFlags} at 8/12/16/20,
    /// KEYBDINPUT {wVk,wScan,dwFlags} at 8/10/12.
    #[test]
    fn input_layout_is_40_bytes_with_fields_at_the_x64_offsets() {
        let mut b = InputBuilder::new();
        b.mouse(32768, 12345, 0, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK);
        b.keyboard(0x41, 0x1E, KEYEVENTF_SCANCODE);
        assert_eq!(b.len(), 2);
        assert_eq!(b.bytes().len(), 80);

        let m = &b.bytes()[0..40];
        assert_eq!(u32::from_le_bytes(m[0..4].try_into().unwrap()), INPUT_MOUSE);
        assert_eq!(i32::from_le_bytes(m[8..12].try_into().unwrap()), 32768);
        assert_eq!(i32::from_le_bytes(m[12..16].try_into().unwrap()), 12345);
        assert_eq!(u32::from_le_bytes(m[16..20].try_into().unwrap()), 0);
        assert_eq!(
            u32::from_le_bytes(m[20..24].try_into().unwrap()),
            MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK
        );

        let k = &b.bytes()[40..80];
        assert_eq!(u32::from_le_bytes(k[0..4].try_into().unwrap()), INPUT_KEYBOARD);
        assert_eq!(u16::from_le_bytes(k[8..10].try_into().unwrap()), 0x41);
        assert_eq!(u16::from_le_bytes(k[10..12].try_into().unwrap()), 0x1E);
        assert_eq!(u32::from_le_bytes(k[12..16].try_into().unwrap()), KEYEVENTF_SCANCODE);
    }

    /// W1 B1, ported: scroll-DOWN is a NEGATIVE wheel delta; the DWORD field
    /// carries it as two's complement (0xFFFFFE98 for -360) — never a
    /// range-check rejection.
    #[test]
    fn wheel_down_encodes_two_complement_never_throws() {
        let mut b = InputBuilder::new();
        b.mouse(0, 0, -360, MOUSEEVENTF_WHEEL);
        let m = &b.bytes()[0..40];
        assert_eq!(u32::from_le_bytes(m[16..20].try_into().unwrap()), 0xFFFF_FE98);
        assert_eq!(i32::from_le_bytes(m[16..20].try_into().unwrap()), -360);

        // Clamp boundaries: ±20 notches = ±2400.
        let mut d = InputBuilder::new();
        d.mouse(0, 0, -2400, MOUSEEVENTF_WHEEL);
        assert_eq!(i32::from_le_bytes(d.bytes()[16..20].try_into().unwrap()), -2400);
        let mut u = InputBuilder::new();
        u.mouse(0, 0, 2400, MOUSEEVENTF_WHEEL);
        assert_eq!(i32::from_le_bytes(u.bytes()[16..20].try_into().unwrap()), 2400);
    }

    /// The VIRTUALDESK normalization the W1 TS moveTo() did inline —
    /// ported 1:1 so multi-monitor clicks land byte-identically.
    #[test]
    fn virtualdesk_normalization_matches_the_w1_math() {
        // W1 TS: Math.round(((x - vx) * 65535) / Math.max(1, vw - 1)) — the
        // divisor is (span - 1), so a 2560-wide monitor's center lands at
        // 32780 (not 32768): byte-exact port, verified against win32.ts.
        let (nx, ny) = normalize_absolute(1280, 800, 0, 0, 2560, 1600);
        assert_eq!((nx, ny), (32780, 32788));
        // A monitor left of the primary: virtual origin -1920.
        let (nx2, _ny2) = normalize_absolute(-1920, 100, -1920, 0, 4480, 1600);
        assert_eq!(nx2, 0);
        // The last valid coordinate of the span normalizes to exactly 65535.
        let (nx3, _) = normalize_absolute(2559, 0, 0, 0, 2560, 1600);
        assert_eq!(nx3, 65535);
    }

    /// unicodeChar: KEYEVENTF_UNICODE carries ONE UTF-16 code unit per
    /// event; an astral char (emoji) arrives as its surrogate PAIR, down
    /// then up per unit (the W1 SURROGATE lesson).
    #[test]
    fn unicode_events_carry_one_utf16_unit_each() {
        let units: Vec<u16> = "😀".encode_utf16().collect();
        assert_eq!(units.len(), 2); // D83D DE00 — the surrogate pair
        let mut b = InputBuilder::new();
        for &u in &units {
            b.keyboard(0, u, KEYEVENTF_UNICODE);
            b.keyboard(0, u, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP);
        }
        assert_eq!(b.len(), 4);
        let e0 = &b.bytes()[0..40];
        assert_eq!(u16::from_le_bytes(e0[10..12].try_into().unwrap()), 0xD83D);
        assert_eq!(u32::from_le_bytes(e0[12..16].try_into().unwrap()), KEYEVENTF_UNICODE);
        // wVk stays 0 for UNICODE events (the code unit rides wScan).
        assert_eq!(u16::from_le_bytes(e0[8..10].try_into().unwrap()), 0);
    }
}
