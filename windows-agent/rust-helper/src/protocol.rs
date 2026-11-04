//! Helper protocol types + the frozen refusal-code table (W3).
//!
//! WIRE: line-delimited JSON over the helper's stdio — one request object
//! per line, exactly one response line per request. (Not JSON-RPC 2.0:
//! no jsonrpc field, no named-parameter objects — the envelope below IS
//! the contract, pinned by test/fake-helper round-trips in the agent's
//! node:test suite and by docs/WINDOWS_W3_SHIPPING.md §protocol.)
//!
//! Request:  {"id":1,"method":"ping","params":{}}
//! Response: {"id":1,"ok":true,"result":{...}}
//!           {"id":1,"ok":false,"error":{"code":"UIA_E_ELEVATED","message":"..."}}
//!
//! REFUSAL CODES are FROZEN (backend wire contract, 2026-09-25): the agent
//! relays them verbatim to the backend as `<CODE>: <human guidance>`. The
//! canonical human-guidance strings live HERE (single source of truth for
//! the helper); commands.ts mirrors the ones it produces agent-side before
//! the helper is even involved (secure-desktop/anti-cheat/elevation
//! preflights). Keep the two tables in sync — docs/WINDOWS_W3_SHIPPING.md
//! §refusals is the rendered copy.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Helper + wire protocol version (tracks the agent's AGENT_VERSION).
pub const VERSION: &str = "0.9.1";

// ── The frozen refusal codes (relay VERBATIM — '<CODE>: <human guidance>') ──

/// Target window elevated/UIPI — synthetic input into a higher-integrity
/// process is silently dropped by Windows.
pub const UIA_E_ELEVATED: &str = "UIA_E_ELEVATED";
/// UAC prompt / lock screen / secure desktop is active — capture and input
/// are impossible until the user dismisses it.
pub const UIA_E_SECURE_DESKTOP: &str = "UIA_E_SECURE_DESKTOP";
/// The window refuses capture (DRM-protected surface, exclusive fullscreen).
pub const UIA_E_DRM: &str = "UIA_E_DRM";
/// The foreground process is on the anti-cheat refusal list — driving a
/// game with anti-cheat protection risks the user's account.
pub const UIA_E_ANTICHEAT: &str = "UIA_E_ANTICHEAT";
/// The runtime_id is stale (the UI tree changed since uia_tree).
pub const UIA_E_NOT_FOUND: &str = "UIA_E_NOT_FOUND";
/// The pattern is not implemented by that element.
pub const UIA_E_UNSUPPORTED: &str = "UIA_E_UNSUPPORTED";
/// WARNING (never an error result): the capture looks DRM-obscured
/// (uniform black where the foreground window should be). Embedded as a
/// warning prefix in observation text, not a refusal.
pub const UIA_W_DRM_SUSPECTED: &str = "UIA_W_DRM_SUSPECTED";

// Helper-internal codes (never the model's business — surfaced as agent
// errors, not relayed as UIA_*).
pub const HELPER_E_PLATFORM: &str = "HELPER_E_PLATFORM";
pub const HELPER_E_INTERNAL: &str = "HELPER_E_INTERNAL";
pub const HELPER_E_PARAMS: &str = "HELPER_E_PARAMS";

/// Canonical human guidance per refusal code — the `<human guidance>` half
/// of the frozen `'<CODE>: <guidance>'` error strings. Single source of
/// truth for helper-produced refusals.
pub fn guidance(code: &str) -> &'static str {
    match code {
        UIA_E_ELEVATED => "the foreground window belongs to an elevated (admin) process, so Windows UIPI blocks synthetic input; ask the user to run the app non-elevated or perform this step by hand",
        UIA_E_SECURE_DESKTOP => "a secure desktop (UAC prompt or lock screen) is active, so the screen cannot be captured or driven; wait for the user to dismiss it",
        UIA_E_DRM => "the target window refuses screen capture (DRM-protected or exclusive-fullscreen content); use computer_uia_tree to perceive it structurally instead",
        UIA_E_ANTICHEAT => "the foreground process is protected by anti-cheat, so capture and input are refused to protect the user's account; ask the user to close the game first",
        UIA_E_NOT_FOUND => "the element is gone (the UI tree changed since the last computer_uia_tree); take a fresh tree and retry with the new runtime_id",
        UIA_E_UNSUPPORTED => "that pattern is not implemented by this element; inspect its role in the tree and pick a pattern it supports",
        _ => "the Windows helper could not complete this action",
    }
}

/// A helper failure: a refusal code (frozen UIA_* when the action is
/// refused for a safety/environment reason) plus human guidance.
#[derive(Debug, Clone)]
pub struct HelperError {
    pub code: &'static str,
    pub message: String,
}

impl HelperError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
    /// A refusal with the canonical guidance text for its code.
    pub fn refuse(code: &'static str) -> Self {
        Self::new(code, guidance(code))
    }
    /// A parameter-validation failure (agent-side validation mirrors these).
    pub fn params(message: impl Into<String>) -> Self {
        Self::new(HELPER_E_PARAMS, message)
    }
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(HELPER_E_INTERNAL, message)
    }
    /// The full wire error string — exactly what the agent relays.
    pub fn wire_string(&self) -> String {
        format!("{}: {}", self.code, self.message)
    }
}

impl std::fmt::Display for HelperError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.wire_string())
    }
}

impl std::error::Error for HelperError {}

// ── The stdio envelope ───────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct Request {
    /// Echoed verbatim in the response (may be any JSON value; the agent
    /// uses incrementing integers).
    pub id: Value,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Serialize)]
pub struct ErrorBody {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Serialize)]
pub struct Response {
    pub id: Value,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorBody>,
}

impl Response {
    pub fn ok(id: Value, result: Value) -> Self {
        Self { id, ok: true, result: Some(result), error: None }
    }
    pub fn err(id: Value, e: &HelperError) -> Self {
        Self {
            id,
            ok: false,
            result: None,
            error: Some(ErrorBody { code: e.code.to_string(), message: e.message.clone() }),
        }
    }
}

/// Serialize a response to exactly one line (no embedded newlines — the
/// line framing IS the protocol).
pub fn encode_line(r: &Response) -> String {
    let mut s = serde_json::to_string(r).expect("response is always serializable");
    s.push('\n');
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refusal_codes_are_frozen_verbatim() {
        // The backend relays these strings VERBATIM — a rename is a wire
        // break. Pinned here and mirrored in the agent's TS test suite.
        assert_eq!(UIA_E_ELEVATED, "UIA_E_ELEVATED");
        assert_eq!(UIA_E_SECURE_DESKTOP, "UIA_E_SECURE_DESKTOP");
        assert_eq!(UIA_E_DRM, "UIA_E_DRM");
        assert_eq!(UIA_E_ANTICHEAT, "UIA_E_ANTICHEAT");
        assert_eq!(UIA_E_NOT_FOUND, "UIA_E_NOT_FOUND");
        assert_eq!(UIA_E_UNSUPPORTED, "UIA_E_UNSUPPORTED");
        assert_eq!(UIA_W_DRM_SUSPECTED, "UIA_W_DRM_SUSPECTED");
    }

    #[test]
    fn every_refusal_has_nonempty_guidance() {
        for code in [UIA_E_ELEVATED, UIA_E_SECURE_DESKTOP, UIA_E_DRM, UIA_E_ANTICHEAT, UIA_E_NOT_FOUND, UIA_E_UNSUPPORTED] {
            assert!(!guidance(code).is_empty(), "{code} needs guidance");
            assert!(guidance(code).len() < 300, "{code} guidance should stay one sentence-ish");
        }
    }

    #[test]
    fn wire_string_is_code_colon_guidance() {
        let e = HelperError::refuse(UIA_E_ELEVATED);
        assert_eq!(e.wire_string(), format!("UIA_E_ELEVATED: {}", guidance(UIA_E_ELEVATED)));
    }

    #[test]
    fn response_encodes_to_a_single_line() {
        let r = Response::ok(serde_json::json!(7), serde_json::json!({"version": VERSION}));
        let line = encode_line(&r);
        assert!(line.ends_with('\n'));
        assert_eq!(line.matches('\n').count(), 1, "no embedded newlines — line framing is the protocol");
        assert!(line.contains("\"id\":7"));
        assert!(line.contains("\"ok\":true"));
    }

    #[test]
    fn error_response_shape() {
        let r = Response::err(serde_json::json!(2), &HelperError::refuse(UIA_E_SECURE_DESKTOP));
        let line = encode_line(&r);
        assert!(line.contains("\"ok\":false"));
        assert!(line.contains("\"code\":\"UIA_E_SECURE_DESKTOP\""));
        assert!(!line.contains("\"result\""), "error responses carry no result field");
    }

    #[test]
    fn request_parses_with_absent_params() {
        let r: Request = serde_json::from_str(r#"{"id":1,"method":"ping"}"#).expect("params optional");
        assert_eq!(r.method, "ping");
        assert!(r.params.is_null());
    }
}
