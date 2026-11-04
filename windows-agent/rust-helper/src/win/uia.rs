//! UI Automation (Windows-only): uia_tree + uia_invoke.
//!
//! API-surface note: this module deliberately uses the TYPED getters on
//! IUIAutomationElement (CurrentName, CurrentAutomationId, CurrentControlType,
//! CurrentBoundingRectangle, CurrentHasKeyboardFocus, GetRuntimeId) and
//! GetCurrentPatternAs::<T>() for patterns — never GetCurrentPropertyValue's
//! VARIANT path. Fewer signatures to get wrong, no VARIANT decoding, and the
//! values are the same.

use crate::protocol::*;
use crate::uia_model::{self, UiaNode};
use serde_json::{json, Value};
use windows::core::{BSTR, Interface};
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED, SAFEARRAY,
};
use windows::Win32::System::Ole::{
    SafeArrayDestroy, SafeArrayGetElement, SafeArrayGetLBound, SafeArrayGetUBound,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationTreeWalker,
    IUIAutomationExpandCollapsePattern, IUIAutomationInvokePattern, IUIAutomationSelectionItemPattern,
    IUIAutomationTogglePattern, IUIAutomationValuePattern, UIA_ExpandCollapsePatternId,
    UIA_InvokePatternId, UIA_SelectionItemPatternId, UIA_TogglePatternId, UIA_ValuePatternId,
};
use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

/// Per-call COM init (STA — the UIA apartment). CoInitializeEx returns
/// S_FALSE (Ok) when already initialized on this thread; CoUninitialize is
/// still the documented balance for that case.
struct ComGuard;

impl ComGuard {
    fn init() -> Result<ComGuard, HelperError> {
        unsafe {
            CoInitializeEx(None, COINIT_APARTMENTTHREADED)
                .ok()
                .map_err(|e| HelperError::internal(format!("CoInitializeEx failed: {e}")))?;
        }
        Ok(ComGuard)
    }
}

impl Drop for ComGuard {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

fn uia() -> Result<IUIAutomation, HelperError> {
    unsafe {
        // windows-rs 0.62 CoCreateInstance is generic over the OUTPUT type
        // (3 args, no out-param): `CoCreateInstance::<P1, T>(clsid, outer, ctx)`.
        CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
            .map_err(|e| HelperError::internal(format!("CoCreateInstance(CUIAutomation) failed: {e}")))
    }
}

fn internal_err(e: windows::core::Error) -> HelperError {
    HelperError::internal(format!("UIA call failed: {e}"))
}

// ── uia_tree ────────────────────────────────────────────────────────────────

pub fn uia_tree(p: &Value) -> Result<Value, HelperError> {
    let root = p.get("root").and_then(Value::as_str).unwrap_or("foreground");
    let (max_depth, max_nodes) = uia_model::clamp_tree_params(
        root,
        p.get("max_depth").and_then(Value::as_u64).map(|v| v as u32),
        p.get("max_nodes").and_then(Value::as_u64).map(|v| v as usize),
    )
    .map_err(HelperError::params)?;

    let _com = ComGuard::init()?;
    let automation = uia()?;
    unsafe {
        let root_el: IUIAutomationElement = match root {
            "desktop" => automation.GetRootElement().map_err(internal_err)?,
            // 'foreground': root the walk at the foreground window; the
            // desktop root is the fallback when there is none (locked
            // session) — the tree still answers instead of erroring.
            _ => foreground_or_root(&automation)?,
        };
        let walker = automation.ControlViewWalker().map_err(internal_err)?;
        let mut count = 1usize;
        let node = element_to_node(&root_el, &walker, max_depth, &mut count)?;
        let (tree, text, taken) = uia_model::tree_result(node, root, max_depth, max_nodes);
        Ok(json!({
            "ok": true,
            "tree": tree,
            "text": text,
            "node_count": taken,
        }))
    }
}

fn foreground_or_root(automation: &IUIAutomation) -> Result<IUIAutomationElement, HelperError> {
    unsafe {
        let fg = GetForegroundWindow();
        if !fg.0.is_null() {
            if let Ok(el) = automation.ElementFromHandle(fg) {
                return Ok(el);
            }
        }
        automation.GetRootElement().map_err(internal_err)
    }
}

/// Convert one UIA element + its control-view subtree to the frozen UiaNode
/// shape. The HARD_MAX_NODES backstop guards the COM walk; the pure
/// uia_model::bound_tree applies the caller's max_nodes afterward.
fn element_to_node(
    el: &IUIAutomationElement,
    walker: &IUIAutomationTreeWalker,
    depth_left: u32,
    count: &mut usize,
) -> Result<UiaNode, HelperError> {
    unsafe {
        let name = el.CurrentName().map(|b| b.to_string()).unwrap_or_default();
        let automation_id = el.CurrentAutomationId().map(|b| b.to_string()).unwrap_or_default();
        let role = control_type_name(el.CurrentControlType().map(|c| c.0).unwrap_or(0));
        let runtime_id = runtime_id_of(el);
        let rect = match el.CurrentBoundingRectangle() {
            Ok(r) => uia_model::Rect { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top },
            Err(_) => uia_model::Rect { x: 0, y: 0, w: 0, h: 0 },
        };
        let focused = el.CurrentHasKeyboardFocus().map(|b| b.as_bool()).unwrap_or(false);
        let value = value_of(el);

        let mut node = UiaNode { name, role, automation_id, runtime_id, rect, focused, value, children: Vec::new() };

        if depth_left > 1 && *count < uia_model::HARD_MAX_NODES {
            let mut child = walker.GetFirstChildElement(el).ok();
            while let Some(c) = child {
                if *count >= uia_model::HARD_MAX_NODES {
                    break;
                }
                *count += 1;
                if let Ok(sub) = element_to_node(&c, walker, depth_left - 1, count) {
                    node.children.push(sub);
                }
                child = walker.GetNextSiblingElement(&c).ok();
            }
        }
        Ok(node)
    }
}

/// RuntimeId: a SAFEARRAY of i32 — walk bounds and copy out.
///
/// DIMENSION INDEX IS 1-BASED (W4 live-desktop finding): the W3 code passed
/// 0, so SafeArrayGetLBound/UBound returned DISP_E_BADINDEX and EVERY
/// element's runtime_id walked out empty — uia_tree never emitted `#id`
/// lines and uia_invoke's find_by_runtime_id could never match, making
/// invoke dead against any live desktop. Invisible to the W3 suite (fake
/// helpers hand-build nodes with runtime ids); caught by the W4 live run
/// (run 36161863314: 27-node real tree, zero `#` markers).
fn runtime_id_of(el: &IUIAutomationElement) -> Vec<i32> {
    unsafe {
        let arr: *mut SAFEARRAY = match el.GetRuntimeId() {
            Ok(a) => a,
            Err(_) => return Vec::new(),
        };
        if arr.is_null() {
            return Vec::new();
        }
        let mut out = Vec::new();
        let lb = match SafeArrayGetLBound(arr, 1) {
            Ok(v) => v,
            Err(_) => return out,
        };
        let ub = match SafeArrayGetUBound(arr, 1) {
            Ok(v) => v,
            Err(_) => return out,
        };
        for i in lb..=ub {
            let mut v: i32 = 0;
            if SafeArrayGetElement(arr, &i, &mut v as *mut i32 as *mut core::ffi::c_void).is_ok() {
                out.push(v);
            }
        }
        let _ = SafeArrayDestroy(arr);
        out
    }
}

/// The element's ValuePattern value (optional — absent when no value pattern).
fn value_of(el: &IUIAutomationElement) -> Option<String> {
    unsafe {
        match el.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) {
            Ok(p) => p.CurrentValue().ok().map(|b| b.to_string()),
            Err(_) => None,
        }
    }
}

/// UIA control type ids → compact role names (UIAutomationClient.h
/// UIA_*ControlTypeId values).
fn control_type_name(n: i32) -> String {
    match n {
        50000 => "button".into(),
        50001 => "calendar".into(),
        50002 => "checkbox".into(),
        50003 => "checkbox".into(),
        50004 => "combobox".into(),
        50005 => "custom".into(),
        50006 => "datagrid".into(),
        50007 => "dataitem".into(),
        50008 => "document".into(),
        50009 => "edit".into(),
        50010 => "group".into(),
        50011 => "header".into(),
        50012 => "headeritem".into(),
        50013 => "hyperlink".into(),
        50014 => "image".into(),
        50015 => "list".into(),
        50016 => "listitem".into(),
        50017 => "menu".into(),
        50018 => "menubar".into(),
        50019 => "menuitem".into(),
        50020 => "pane".into(),
        50021 => "progressbar".into(),
        50022 => "radiobutton".into(),
        50023 => "scrollbar".into(),
        50024 => "separator".into(),
        50025 => "slider".into(),
        50026 => "spinner".into(),
        50027 => "splitbutton".into(),
        50028 => "statusbar".into(),
        50029 => "tab".into(),
        50030 => "tabitem".into(),
        50031 => "table".into(),
        50032 => "text".into(),
        50033 => "thumb".into(),
        50034 => "titlebar".into(),
        50035 => "toolbar".into(),
        50036 => "tooltip".into(),
        50037 => "tree".into(),
        50038 => "treeitem".into(),
        50039 => "window".into(),
        _ => format!("type{n}"),
    }
}

// ── uia_invoke ──────────────────────────────────────────────────────────────

pub fn uia_invoke(p: &Value) -> Result<Value, HelperError> {
    let runtime_id: Vec<i32> = p
        .get("runtime_id")
        .and_then(Value::as_array)
        .and_then(|a| a.iter().map(|v| v.as_i64().map(|n| n as i32)).collect::<Option<Vec<i32>>>())
        .filter(|a| !a.is_empty())
        .ok_or_else(|| HelperError::params("uia_invoke requires runtime_id: number[] (non-empty)"))?;
    let pattern = p.get("pattern").and_then(Value::as_str).unwrap_or("");
    let value = p.get("value").and_then(Value::as_str);

    // SAFETY PREFLIGHT (review B3): invoke drives the UI — the same
    // secure-desktop refusal as the SendInput paths applies (defense in
    // depth: the agent also preflights; this is the helper-side backstop).
    if crate::win::env::secure_desktop_active()? {
        return Err(HelperError::refuse(UIA_E_SECURE_DESKTOP));
    }

    let _com = ComGuard::init()?;
    let automation = uia()?;
    unsafe {
        let root = foreground_or_root(&automation)?;
        let walker = automation.ControlViewWalker().map_err(internal_err)?;
        let target = find_by_runtime_id(&walker, &root, &runtime_id, uia_model::HARD_MAX_DEPTH, uia_model::HARD_MAX_NODES)?;

        let Some(el) = target else {
            return Err(HelperError::refuse(UIA_E_NOT_FOUND));
        };

        // The backend driver follows up with computer_screenshot exactly as
        // after click/type — the helper does NOT capture on invoke.
        match pattern {
            "invoke" => {
                let pat = pattern_as::<IUIAutomationInvokePattern>(&el, UIA_InvokePatternId)?;
                pat.Invoke().map_err(|_| HelperError::refuse(UIA_E_NOT_FOUND))?;
            }
            "toggle" => {
                let pat = pattern_as::<IUIAutomationTogglePattern>(&el, UIA_TogglePatternId)?;
                pat.Toggle().map_err(|_| HelperError::refuse(UIA_E_NOT_FOUND))?;
            }
            "expand" => {
                let pat = pattern_as::<IUIAutomationExpandCollapsePattern>(&el, UIA_ExpandCollapsePatternId)?;
                pat.Expand().map_err(|_| HelperError::refuse(UIA_E_NOT_FOUND))?;
            }
            "select" => {
                let pat = pattern_as::<IUIAutomationSelectionItemPattern>(&el, UIA_SelectionItemPatternId)?;
                pat.Select().map_err(|_| HelperError::refuse(UIA_E_NOT_FOUND))?;
            }
            "focus" => {
                el.SetFocus().map_err(|_| HelperError::refuse(UIA_E_NOT_FOUND))?;
            }
            "set_value" => {
                let v = value.ok_or_else(|| HelperError::params("set_value requires a value string"))?;
                let pat = pattern_as::<IUIAutomationValuePattern>(&el, UIA_ValuePatternId)?;
                pat.SetValue(&BSTR::from(v)).map_err(|_| HelperError::refuse(UIA_E_NOT_FOUND))?;
            }
            other => return Err(HelperError::params(format!("invalid pattern: {other} (invoke|toggle|expand|select|focus|set_value)"))),
        }
        Ok(json!({ "ok": true }))
    }
}

/// Typed pattern retrieval; a missing pattern on the element is
/// UIA_E_UNSUPPORTED (frozen code) — the caller retries with another pattern.
fn pattern_as<T: Interface>(el: &IUIAutomationElement, pattern_id: windows::Win32::UI::Accessibility::UIA_PATTERN_ID) -> Result<T, HelperError> {
    unsafe { el.GetCurrentPatternAs::<T>(pattern_id).map_err(|_| HelperError::refuse(UIA_E_UNSUPPORTED)) }
}

/// Depth-first search for an element whose RuntimeId matches.
fn find_by_runtime_id(
    walker: &IUIAutomationTreeWalker,
    root: &IUIAutomationElement,
    want: &[i32],
    max_depth: u32,
    max_nodes: usize,
) -> Result<Option<IUIAutomationElement>, HelperError> {
    unsafe {
        let mut budget = max_nodes;
        let mut stack: Vec<(IUIAutomationElement, u32)> = vec![(root.clone(), 0u32)];
        while let Some((el, depth)) = stack.pop() {
            if budget == 0 {
                break;
            }
            budget -= 1;
            if runtime_id_of(&el) == want {
                return Ok(Some(el));
            }
            if depth < max_depth {
                let mut child = walker.GetFirstChildElement(&el).ok();
                while let Some(c) = child {
                    stack.push((c.clone(), depth + 1));
                    child = walker.GetNextSiblingElement(&c).ok();
                }
            }
        }
        Ok(None)
    }
}

// HWND import anchor (ElementFromHandle takes Foundation::HWND — the UIA_HWND
// alias does not exist in windows 0.62).
const _: Option<HWND> = None;
