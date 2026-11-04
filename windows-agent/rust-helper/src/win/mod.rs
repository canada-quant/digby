//! Win32 implementation (Windows-only). Pure logic lives in the sibling
//! modules (protocol, input, uia_model, drm); this directory is the
//! `windows` crate surface behind #[cfg(windows)]:
//!
//!   capture.rs — Windows Graphics Capture + the GDI BitBlt fallback
//!   input.rs   — SendInput via the pure InputBuilder byte layout
//!   uia.rs     — UI Automation tree walk + pattern invoke
//!   env.rs     — secure-desktop + elevated-foreground detection
//!   mod.rs     — the method dispatch table (request → response)

pub mod capture;
pub mod env;
pub mod input;
pub mod uia;

use crate::input::KeySpec;
use crate::protocol::*;
use serde_json::{json, Value};

/// Dispatch one parsed request to its Win32 implementation. The stdio loop
/// in main.rs owns framing; this owns semantics.
pub fn dispatch(req: &Request) -> Response {
    let id = req.id.clone();
    let params = req.params.clone();
    let result = match req.method.as_str() {
        "ping" => Ok(json!({ "version": VERSION, "platform": "windows" })),
        "monitor_size" => monitor_size(&params),
        "capture_bgra" => capture_bgra(&params),
        "frontmost" => frontmost(&params),
        "geometry" => geometry(&params),
        "cursor_pos" => cursor_pos(&params),
        "move_to" => move_to(&params),
        "mouse_down" => mouse_button(&params, true),
        "mouse_up" => mouse_button(&params, false),
        "scroll" => scroll(&params),
        "key_down" => key_event(&params, false),
        "key_up" => key_event(&params, true),
        "unicode_char" => unicode_char(&params),
        "clear_modifiers" => clear_modifiers(&params),
        "open" => open(&params),
        "uia_tree" => uia::uia_tree(&params),
        "uia_invoke" => uia::uia_invoke(&params),
        "environment_check" => environment_check(&params),
        other => Err(HelperError::params(format!("unknown method: {other}"))),
    };
    match result {
        Ok(v) => Response::ok(id, v),
        Err(e) => Response::err(id, &e),
    }
}

// ── Geometry / state probes ─────────────────────────────────────────────────

fn monitor_size(_p: &Value) -> Result<Value, HelperError> {
    let (w, h) = capture::virtual_screen_metrics()?;
    Ok(json!({ "width": w, "height": h }))
}

fn geometry(_p: &Value) -> Result<Value, HelperError> {
    capture::geometry_snapshot()
}

fn cursor_pos(_p: &Value) -> Result<Value, HelperError> {
    input::cursor_pos()
}

fn frontmost(_p: &Value) -> Result<Value, HelperError> {
    env::frontmost_json()
}

// ── Capture ─────────────────────────────────────────────────────────────────

fn capture_bgra(_p: &Value) -> Result<Value, HelperError> {
    // The AGENT owns JPEG encoding + downscaling (jpeg-js, TS side); the
    // helper returns raw full-resolution BGRA + dims + backend + origin +
    // the frame-side DRM heuristic verdict (the agent embeds the warning
    // line when true; its own heuristic is the fallback for older helpers).
    let handle = capture::capture_once()?;
    Ok(json!({
        "bgra_b64": handle.bgra_b64,
        "width": handle.width,
        "height": handle.height,
        "backend": handle.backend,       // "wgc" | "gdi"
        "vx": handle.vx,
        "vy": handle.vy,
        "drm_suspected": handle.drm_suspected,
    }))
}

// ── Input injection (SendInput) ─────────────────────────────────────────────

fn move_to(p: &Value) -> Result<Value, HelperError> {
    let x = p.get("x").and_then(Value::as_i64).ok_or_else(|| HelperError::params("move_to requires numeric x"))?;
    let y = p.get("y").and_then(Value::as_i64).ok_or_else(|| HelperError::params("move_to requires numeric y"))?;
    input::move_to(x as i32, y as i32)
}

fn mouse_button(p: &Value, down: bool) -> Result<Value, HelperError> {
    let button = p.get("button").and_then(Value::as_str).unwrap_or("left");
    if button != "left" && button != "right" {
        return Err(HelperError::params(format!("invalid button: {button} (left|right)")));
    }
    input::mouse_button(button, down)
}

fn scroll(p: &Value) -> Result<Value, HelperError> {
    let amount = p.get("amount").and_then(Value::as_i64).ok_or_else(|| HelperError::params("scroll requires numeric amount (positive = up)"))?;
    input::scroll(amount as i32)
}

fn key_event(p: &Value, up: bool) -> Result<Value, HelperError> {
    let vk = p.get("vk").and_then(Value::as_u64).ok_or_else(|| HelperError::params("key_down/key_up require numeric vk"))? as u16;
    let scan = p.get("scan").and_then(Value::as_u64).ok_or_else(|| HelperError::params("key_down/key_up require numeric scan"))? as u16;
    let extended = p.get("extended").and_then(Value::as_bool).unwrap_or(false);
    let shift = p.get("shift").and_then(Value::as_bool).unwrap_or(false);
    input::key_event(KeySpec { vk, scan, shift, extended }, up)
}

fn unicode_char(p: &Value) -> Result<Value, HelperError> {
    let ch = p.get("ch").and_then(Value::as_str).ok_or_else(|| HelperError::params("unicode_char requires a string ch"))?;
    input::unicode_char(ch)
}

fn clear_modifiers(_p: &Value) -> Result<Value, HelperError> {
    input::clear_modifiers()
}

fn open(p: &Value) -> Result<Value, HelperError> {
    let target = p.get("target").and_then(Value::as_str).ok_or_else(|| HelperError::params("open requires a string target"))?;
    env::shell_open(target)
}

fn environment_check(_p: &Value) -> Result<Value, HelperError> {
    env::environment_check()
}
