//! SendInput injection (Windows-only), via the pure InputBuilder byte
//! layout + the secure-desktop preflight. Elevation detection for input
//! actions lives in env.rs (the agent runs it as a preflight before
//! planning; the helper's SendInput return-count check is the backstop).

use crate::input::*;
use crate::protocol::*;
use crate::win::env;
use serde_json::{json, Value};
// Types + SendInput from the windows crate — the INPUT/MOUSEEVENTF/KEYEVENTF
// CONSTANTS live in crate::input (the pure ABI layer) and must not be
// glob-shadowed here (E0659 ambiguity).
use windows::Win32::Foundation::POINT;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYBD_EVENT_FLAGS, MOUSEINPUT,
    MOUSE_EVENT_FLAGS, SendInput, VIRTUAL_KEY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
    SM_YVIRTUALSCREEN,
};

// Shift + modifier specs (mirror win-platform.ts's NAMED_KEYS — the agent
// plans these; the helper applies them for clearModifiers).
const SHIFT_VK: u16 = 0x10;
const SHIFT_SCAN: u16 = 0x2A;
const CTRL_VK: u16 = 0x11;
const CTRL_SCAN: u16 = 0x1D;
const ALT_VK: u16 = 0x12;
const ALT_SCAN: u16 = 0x38;
const LWIN_VK: u16 = 0x5B;
const LWIN_SCAN: u16 = 0x5B;

pub fn cursor_pos() -> Result<Value, HelperError> {
    unsafe {
        let mut pt = POINT::default();
        if GetCursorPos(&mut pt).is_err() {
            return Ok(Value::Null);
        }
        Ok(json!({ "x": pt.x, "y": pt.y }))
    }
}

/// Send a planned batch. SendInput reporting fewer accepted events than
/// requested is the documented UIPI signature → UIA_E_ELEVATED.
fn send(b: &mut InputBuilder) -> Result<(), HelperError> {
    if b.is_empty() {
        return Ok(());
    }
    let inputs = to_input_array(b.bytes());
    let accepted = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
    if (accepted as usize) < inputs.len() {
        return Err(HelperError::refuse(UIA_E_ELEVATED));
    }
    Ok(())
}

/// Interpret the InputBuilder's byte layout as `windows` crate INPUT
/// structs (the ABI the pure serializer owns). The constants are
/// newtype-wrapped in the windows crate; our u32s are the same values.
fn to_input_array(bytes: &[u8]) -> Vec<INPUT> {
    let mouse_ty = INPUT_MOUSE; // crate::input::INPUT_MOUSE (0)
    let kbd_ty = INPUT_KEYBOARD; // crate::input::INPUT_KEYBOARD (1)
    let _ = (mouse_ty, kbd_ty);
    let mut out = Vec::with_capacity(bytes.len() / INPUT_SIZE);
    for i in 0..bytes.len() / INPUT_SIZE {
        let o = i * INPUT_SIZE;
        let kind = u32::from_le_bytes(bytes[o..o + 4].try_into().unwrap());
        if kind == crate::input::INPUT_MOUSE {
            out.push(INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: INPUT_0 {
                    mi: MOUSEINPUT {
                        dx: i32::from_le_bytes(bytes[o + 8..o + 12].try_into().unwrap()),
                        dy: i32::from_le_bytes(bytes[o + 12..o + 16].try_into().unwrap()),
                        mouseData: i32::from_le_bytes(bytes[o + 16..o + 20].try_into().unwrap()) as u32,
                        dwFlags: MOUSE_EVENT_FLAGS(u32::from_le_bytes(bytes[o + 20..o + 24].try_into().unwrap())),
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            });
        } else {
            out.push(INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VIRTUAL_KEY(u16::from_le_bytes(bytes[o + 8..o + 10].try_into().unwrap())),
                        wScan: u16::from_le_bytes(bytes[o + 10..o + 12].try_into().unwrap()),
                        dwFlags: KEYBD_EVENT_FLAGS(u32::from_le_bytes(bytes[o + 12..o + 16].try_into().unwrap())),
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            });
        }
    }
    out
}

/// Absolute move in VIRTUAL-SCREEN space (the W1 contract): normalize
/// (x, y) to 0..65535 across the whole desktop — multi-monitor correct.
pub fn move_to(x: i32, y: i32) -> Result<Value, HelperError> {
    if env::secure_desktop_active()? {
        return Err(HelperError::refuse(UIA_E_SECURE_DESKTOP));
    }
    unsafe {
        let vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
        let vw = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        let vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        if vw <= 0 || vh <= 0 {
            return Err(HelperError::internal("virtual screen metrics unavailable"));
        }
        let (nx, ny) = normalize_absolute(x, y, vx, vy, vw, vh);
        let mut b = InputBuilder::new();
        b.mouse(nx, ny, 0, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK);
        send(&mut b)?;
        Ok(json!({ "ok": true }))
    }
}

pub fn mouse_button(button: &str, down: bool) -> Result<Value, HelperError> {
    if env::secure_desktop_active()? {
        return Err(HelperError::refuse(UIA_E_SECURE_DESKTOP));
    }
    let flag = match (button, down) {
        ("left", true) => MOUSEEVENTF_LEFTDOWN,
        ("left", false) => MOUSEEVENTF_LEFTUP,
        ("right", true) => MOUSEEVENTF_RIGHTDOWN,
        ("right", false) => MOUSEEVENTF_RIGHTUP,
        _ => return Err(HelperError::params(format!("invalid button {button}"))),
    };
    let mut b = InputBuilder::new();
    b.mouse(0, 0, 0, flag);
    send(&mut b)?;
    Ok(json!({ "ok": true }))
}

/// Vertical wheel: positive = up (the macOS contract), clamped ±20 notches.
pub fn scroll(amount: i32) -> Result<Value, HelperError> {
    if env::secure_desktop_active()? {
        return Err(HelperError::refuse(UIA_E_SECURE_DESKTOP));
    }
    let notches = amount.clamp(-20, 20);
    if notches == 0 {
        return Ok(json!({ "ok": true }));
    }
    let mut b = InputBuilder::new();
    b.mouse(0, 0, notches * WHEEL_DELTA, MOUSEEVENTF_WHEEL);
    send(&mut b)?;
    Ok(json!({ "ok": true }))
}

/// Scancode key event (KEYEVENTF_SCANCODE — layout-stable physical key).
/// A shifted char presses the REAL shift key first (never flags alone).
pub fn key_event(spec: KeySpec, up: bool) -> Result<Value, HelperError> {
    if env::secure_desktop_active()? {
        return Err(HelperError::refuse(UIA_E_SECURE_DESKTOP));
    }
    let mut b = InputBuilder::new();
    if up {
        b.keyboard(spec.vk, spec.scan, KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP | (if spec.extended { KEYEVENTF_EXTENDEDKEY } else { 0 }));
        if spec.shift {
            b.keyboard(SHIFT_VK, SHIFT_SCAN, KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP);
        }
    } else {
        if spec.shift {
            b.keyboard(SHIFT_VK, SHIFT_SCAN, KEYEVENTF_SCANCODE);
        }
        b.keyboard(spec.vk, spec.scan, KEYEVENTF_SCANCODE | (if spec.extended { KEYEVENTF_EXTENDEDKEY } else { 0 }));
    }
    send(&mut b)?;
    Ok(json!({ "ok": true }))
}

/// KEYEVENTF_UNICODE: one event per UTF-16 code unit, down + up — an
/// astral char (emoji) arrives as its SURROGATE PAIR (the W1 lesson).
pub fn unicode_char(ch: &str) -> Result<Value, HelperError> {
    if env::secure_desktop_active()? {
        return Err(HelperError::refuse(UIA_E_SECURE_DESKTOP));
    }
    let mut b = InputBuilder::new();
    for unit in ch.encode_utf16() {
        b.keyboard(0, unit, KEYEVENTF_UNICODE);
        b.keyboard(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP);
    }
    if b.is_empty() {
        return Ok(json!({ "ok": true }));
    }
    send(&mut b)?;
    Ok(json!({ "ok": true }))
}

/// Modifier-clearing pre-sweep: SendInput KEYUP for ctrl/alt/shift/win —
/// UP-only releases (a char racing a modifier press becomes a shortcut).
pub fn clear_modifiers() -> Result<Value, HelperError> {
    if env::secure_desktop_active()? {
        return Err(HelperError::refuse(UIA_E_SECURE_DESKTOP));
    }
    let mut b = InputBuilder::new();
    for (vk, scan) in [(CTRL_VK, CTRL_SCAN), (ALT_VK, ALT_SCAN), (SHIFT_VK, SHIFT_SCAN), (LWIN_VK, LWIN_SCAN)] {
        b.keyboard(vk, scan, KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP);
    }
    send(&mut b)?;
    Ok(json!({ "ok": true }))
}
