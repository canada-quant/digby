//! DRM-suspected heuristic — the `UIA_W_DRM_SUSPECTED` warning (W3).
//!
//! A WARNING, never a refusal: a captured frame whose FOREGROUND-WINDOW RECT
//! is uniform black suggests the window refuses pixel capture (DRM /
//! exclusive fullscreen / protected content). The observation text carries a
//! `UIA_W_DRM_SUSPECTED:` prefix line; the screenshot is still delivered —
//! the model sees the black rect and the warning and can fall back to
//! computer_uia_tree for structural perception.
//!
//! PURE (operates on the BGRA buffer + rect) — unit-tested on the Linux host.

/// A capture's pixel buffer, its dims, and the foreground window's rect in
/// the same coordinate space.
pub struct FrameProbe<'a> {
    pub pixels: &'a [u8], // BGRA, 4 bytes/px, row-major, no padding
    pub width: usize,
    pub height: usize,
    pub rect: Option<(i32, i32, i32, i32)>, // x, y, w, h (virtual-screen px)
    /// Virtual-screen origin of the capture (the rect and the capture share
    /// the space when both come from the same geometry snapshot).
    pub vx: i32,
    pub vy: i32,
}

/// Uniform-black threshold: at 4:2:0-ish JPEG noise a truly uniform black
/// rect still shows values ≤ 8 in every channel; ordinary UI has edges,
/// text and highlight colors well above.
const BLACK_MAX: u8 = 8;
/// A rect smaller than this is not worth calling DRM (a 64×64 corner is
/// more likely a taskbar thumbnail or an idle black widget).
const MIN_RECT_AREA_PX: i64 = 256 * 256;
/// Sample at most this many pixels (stride sampling on huge rects).
const MAX_SAMPLES: usize = 40_000;

/// True when the foreground window's rect is uniform black in this frame —
/// the DRM-suspected signature. False on: no rect (no foreground window),
/// empty/degenerate rect, out-of-bounds rect, or any non-black sample.
pub fn drm_suspected(frame: &FrameProbe) -> bool {
    let Some((rx, ry, rw, rh)) = frame.rect else { return false };
    if rw <= 0 || rh <= 0 || frame.width == 0 || frame.height == 0 { return false; }
    if (rw as i64) * (rh as i64) < MIN_RECT_AREA_PX { return false; }

    // Clip the rect to the capture (a partially offscreen window).
    let x0 = (rx - frame.vx).max(0) as usize;
    let y0 = (ry - frame.vy).max(0) as usize;
    let x1 = ((rx + rw - frame.vx).max(0) as usize).min(frame.width);
    let y1 = ((ry + rh - frame.vy).max(0) as usize).min(frame.height);
    if x1 <= x0 || y1 <= y0 { return false; }

    let total = (x1 - x0) * (y1 - y0);
    if total < MIN_RECT_AREA_PX as usize { return false; }
    // Stride so huge rects cost bounded work.
    let stride = ((total / MAX_SAMPLES) + 1).max(1);
    let mut sampled = 0usize;
    let mut i = y0;
    while i < y1 {
        let mut j = x0;
        while j < x1 {
            let o = (i * frame.width + j) * 4;
            let b = frame.pixels.get(o).copied().unwrap_or(0);
            let g = frame.pixels.get(o + 1).copied().unwrap_or(0);
            let r = frame.pixels.get(o + 2).copied().unwrap_or(0);
            if b > BLACK_MAX || g > BLACK_MAX || r > BLACK_MAX {
                return false; // a single non-black pixel clears the suspicion
            }
            sampled += 1;
            j += stride;
        }
        i += stride;
    }
    sampled > 0
}

/// The warning line embedded in observation text (frozen prefix).
pub fn drm_warning_line() -> String {
    format!("{}: the foreground window's pixels are uniformly black in the capture — likely DRM-protected or refusing pixel capture; use computer_uia_tree for structural perception of this window", crate::protocol::UIA_W_DRM_SUSPECTED)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(pixels: &[u8], w: usize, h: usize, rect: Option<(i32, i32, i32, i32)>) -> FrameProbe<'_> {
        FrameProbe { pixels, width: w, height: h, rect, vx: 0, vy: 0 }
    }

    fn black_frame(w: usize, h: usize) -> Vec<u8> {
        vec![0u8; w * h * 4]
    }

    #[test]
    fn uniform_black_foreground_rect_is_suspected() {
        let w = 600; let h = 400;
        let px = black_frame(w, h);
        assert!(drm_suspected(&frame(&px, w, h, Some((0, 0, w as i32, h as i32)))));
    }

    #[test]
    fn one_bright_region_clears_the_suspicion() {
        // The heuristic STRIDE-SAMPLES huge rects (bounded work), so an
        // isolated single pixel may legitimately be skipped — the test uses
        // a realistic bright BAND (a line of text UI), which any stride hits.
        let w = 600; let h = 400;
        let mut px = black_frame(w, h);
        for x in 0..w {
            for y in (h / 2)..(h / 2 + 8) {
                let o = (y * w + x) * 4;
                px[o] = 0xff; px[o + 1] = 0xff; px[o + 2] = 0xff;
            }
        }
        assert!(!drm_suspected(&frame(&px, w, h, Some((0, 0, w as i32, h as i32)))));
    }

    #[test]
    fn stride_sampling_still_bounded_and_black_only_when_uniform() {
        // A fully black rect (any stride) stays suspected; sampling never
        // invents brightness.
        let w = 600; let h = 400;
        let px = black_frame(w, h);
        assert!(drm_suspected(&frame(&px, w, h, Some((0, 0, w as i32, h as i32)))));
    }

    #[test]
    fn small_rect_is_not_drm() {
        let w = 600; let h = 400;
        let px = black_frame(w, h);
        // 200×150 = 30,000 < 256*256 → too small to call.
        assert!(!drm_suspected(&frame(&px, w, h, Some((10, 10, 200, 150)))));
    }

    #[test]
    fn no_rect_or_degenerate_rect_is_not_suspected() {
        let w = 600; let h = 400;
        let px = black_frame(w, h);
        assert!(!drm_suspected(&frame(&px, w, h, None)));
        assert!(!drm_suspected(&frame(&px, w, h, Some((0, 0, 0, 0)))));
        assert!(!drm_suspected(&frame(&px, w, h, Some((-5, -5, -10, -10)))));
    }

    #[test]
    fn offscreen_clipping_still_detects_a_fully_black_visible_part() {
        // A window mostly offscreen to the right; visible part is large + black.
        let w = 600; let h = 400;
        let px = black_frame(w, h);
        assert!(drm_suspected(&frame(&px, w, h, Some((-200, 0, 800, 400)))));
    }

    #[test]
    fn warning_line_uses_the_frozen_prefix() {
        let l = drm_warning_line();
        assert!(l.starts_with("UIA_W_DRM_SUSPECTED: "));
    }
}
