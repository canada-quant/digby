//! digby-win-helper — the W3 Rust helper (crate root).
//!
//! Module layout:
//!   protocol  — the stdio envelope + the FROZEN refusal-code table (pure)
//!   input     — SendInput INPUT-struct serialization (pure ABI layer)
//!   uia_model — the UiaNode wire shape + tree bounding/linearization (pure)
//!   drm       — the uniform-black DRM heuristic (pure)
//!   win/      — the Win32 implementation (cfg(windows)): capture (WGC+GDI),
//!              input, UIA, environment checks, and the method dispatch
//!
//! The pure modules compile + unit-test on ANY host (Linux CI runs
//! `cargo test`); the win/ tree compiles only for Windows targets. main.rs
//! is the stdio JSON loop — one request line in, one response line out.

pub mod drm;
pub mod input;
pub mod protocol;
pub mod uia_model;

#[cfg(windows)]
pub mod win;

use protocol::{HelperError, Request, Response};
use serde_json::Value;

/// The full method surface (both platforms — unknown methods are a
/// PROTOCOL error regardless of host, so a typo'd method name is never
/// masked by the platform error).
pub const METHODS: &[&str] = &[
    "ping", "monitor_size", "capture_bgra", "frontmost", "geometry", "cursor_pos",
    "move_to", "mouse_down", "mouse_up", "scroll", "key_down", "key_up",
    "unicode_char", "clear_modifiers", "open", "uia_tree", "uia_invoke",
    "environment_check",
];

/// Dispatch a request on any platform: the Windows build routes to the
/// Win32 implementation; every other build answers Win32 methods with the
/// structured HELPER_E_PLATFORM error (so the agent's client tests can
/// exercise the protocol against a real spawned binary even on Linux).
pub fn dispatch(req: &Request) -> Response {
    if req.method != "ping" && !METHODS.contains(&req.method.as_str()) {
        return Response::err(
            req.id.clone(),
            &HelperError::params(format!("unknown method: {}", req.method)),
        );
    }
    #[cfg(windows)]
    {
        win::dispatch(req)
    }
    #[cfg(not(windows))]
    {
        let id = req.id.clone();
        if req.method == "ping" {
            return Response::ok(
                id,
                serde_json::json!({ "version": protocol::VERSION, "platform": std::env::consts::OS }),
            );
        }
        Response::err(
            id,
            &HelperError::new(
                protocol::HELPER_E_PLATFORM,
                format!(
                    "this digby-win-helper binary was built for {} — the Win32 implementation requires a Windows build",
                    std::env::consts::OS
                ),
            ),
        )
    }
}

/// Parse one request line → Response (protocol-level errors become error
/// responses with id null — the line had no trustworthy id).
pub fn handle_line(line: &str) -> Response {
    match serde_json::from_str::<Request>(line) {
        Ok(req) => dispatch(&req),
        Err(e) => Response::err(
            Value::Null,
            &HelperError::params(format!("malformed request line: {e}")),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ping_answers_on_any_platform() {
        let req: Request = serde_json::from_str(r#"{"id":1,"method":"ping","params":{}}"#).unwrap();
        let resp = dispatch(&req);
        assert!(resp.ok);
        let line = protocol::encode_line(&resp);
        assert!(line.contains("\"version\":\"0.9.1\""));
    }

    #[test]
    fn non_windows_builds_refuse_win32_methods_with_the_platform_code() {
        // On a Windows host this dispatches for real; on Linux CI it must
        // produce the structured platform error (the agent's client tests
        // rely on this exact shape).
        if cfg!(windows) {
            return;
        }
        let req: Request =
            serde_json::from_str(r#"{"id":5,"method":"monitor_size","params":{}}"#).unwrap();
        let resp = dispatch(&req);
        assert!(!resp.ok);
        let line = protocol::encode_line(&resp);
        assert!(line.contains("\"code\":\"HELPER_E_PLATFORM\""), "got: {line}");
        assert!(line.contains("\"id\":5"), "the id echoes back");
    }

    #[test]
    fn malformed_lines_get_an_error_response_not_a_crash() {
        let resp = handle_line("not json at all");
        assert!(!resp.ok);
        assert!(resp.id.is_null());
        let line = protocol::encode_line(&resp);
        assert!(line.contains("malformed request line"));
    }

    #[test]
    fn unknown_method_is_a_params_error() {
        let resp = handle_line(r#"{"id":9,"method":"nope","params":{}}"#);
        assert!(!resp.ok);
        assert!(protocol::encode_line(&resp).contains("unknown method: nope"));
    }
}
