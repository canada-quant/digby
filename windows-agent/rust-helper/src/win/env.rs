//! Environment + safety checks (Windows-only): secure-desktop detection,
//! elevated-foreground detection, frontmost-window lookup, ShellExecute.

use crate::protocol::*;
use serde_json::{json, Value};
use windows::core::PWSTR;
use windows::Win32::Foundation::{CloseHandle, POINT, RECT};
use windows::Win32::Security::{
    GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
};
use windows::Win32::System::StationsAndDesktops::{GetThreadDesktop, OpenInputDesktop};
use windows::Win32::System::Threading::{
    GetCurrentThreadId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId,
    WindowFromPoint, SW_SHOWNORMAL,
};

/// True when a secure desktop (UAC prompt / lock screen) is active.
///
/// Heuristic (documented): OpenInputDesktop fails with access-denied for a
/// normal-integrity process when the INPUT desktop is the secure one; a
/// successful open with DESKTOP_READOBJECTS means the user desktop is live.
pub fn secure_desktop_active() -> Result<bool, HelperError> {
    unsafe {
        // Request the minimum useful access set; the failure signal is the
        // point, not the handle (GetThreadDesktop is kept for the audit log
        // symmetry with the classic MSDN sample).
        use windows::Win32::System::StationsAndDesktops::{
            DESKTOP_READOBJECTS, DESKTOP_CONTROL_FLAGS,
        };
        match OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS) {
            Ok(h) => {
                let _thread_desk = GetThreadDesktop(GetCurrentThreadId());
                let _ = CloseHandle(windows::Win32::Foundation::HANDLE(h.0));
                Ok(false)
            }
            Err(_) => Ok(true),
        }
    }
}

/// The foreground window's (pid, exe name, title, rect).
struct Foreground {
    pid: u32,
    exe: String,
    title: String,
    rect: (i32, i32, i32, i32),
}

fn foreground_info() -> Foreground {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return Foreground { pid: 0, exe: String::new(), title: String::new(), rect: (0, 0, 0, 0) };
        }
        let mut title = [0u16; 512];
        let n = GetWindowTextW(hwnd, &mut title);
        let title_s = String::from_utf16_lossy(&title[..n.max(0) as usize]);
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        let mut rect = RECT::default();
        let _ = GetWindowRect(hwnd, &mut rect);
        let exe = process_image_name(pid);
        Foreground { pid, exe, title: title_s, rect: (rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top) }
    }
}

fn process_image_name(pid: u32) -> String {
    if pid == 0 {
        return String::new();
    }
    unsafe {
        let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return String::new();
        };
        let mut buf = [0u16; 1024];
        let mut size = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut size);
        let _ = CloseHandle(h);
        if ok.is_ok() {
            let path = String::from_utf16_lossy(&buf[..size as usize]);
            path.rsplit('\\').next().unwrap_or("").to_string()
        } else {
            String::new()
        }
    }
}

/// True when the FOREGROUND window's process runs elevated (UIPI then
/// blocks SendInput) — the W1 elevation_blocked contract, now UIA_E_ELEVATED.
pub fn foreground_elevated() -> Result<bool, HelperError> {
    let fg = foreground_info();
    if fg.pid == 0 {
        return Ok(false);
    }
    unsafe {
        let Ok(hproc) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, fg.pid) else {
            // Cannot even open a visible foreground process ⇒ above our
            // integrity level — report elevated rather than hide it.
            return Ok(true);
        };
        let mut htoken = windows::Win32::Foundation::HANDLE::default();
        let opened = windows::Win32::System::Threading::OpenProcessToken(hproc, TOKEN_QUERY, &mut htoken);
        let _ = CloseHandle(hproc);
        if opened.is_err() {
            return Ok(false);
        }
        let mut elev = TOKEN_ELEVATION::default();
        let mut ret = 0u32;
        let ok = GetTokenInformation(
            htoken,
            TokenElevation,
            Some(&mut elev as *mut TOKEN_ELEVATION as *mut core::ffi::c_void),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut ret,
        );
        let _ = CloseHandle(htoken);
        if ok.is_err() {
            return Ok(false);
        }
        Ok(elev.TokenIsElevated != 0)
    }
}

/// The foreground window's rect in virtual-screen coordinates (None when no
/// foreground window) — the DRM heuristic's probe region.
pub fn foreground_rect() -> Option<(i32, i32, i32, i32)> {
    let fg = foreground_info();
    if fg.pid == 0 || fg.rect.2 <= 0 || fg.rect.3 <= 0 {
        return None;
    }
    Some(fg.rect)
}

/// The `frontmost` result: app (exe) + window title (null when no fg window).
pub fn frontmost_json() -> Result<Value, HelperError> {
    let fg = foreground_info();
    if fg.pid == 0 {
        return Ok(Value::Null);
    }
    Ok(json!({ "app": fg.exe, "window": fg.title }))
}

/// The `environment_check` result — secure-desktop + elevated-foreground +
/// foreground exe/title/rect/pid (the DRM heuristic needs the rect; the
/// anti-cheat check needs the exe).
pub fn environment_check() -> Result<Value, HelperError> {
    let secure = secure_desktop_active()?;
    let elevated = if secure { false } else { foreground_elevated().unwrap_or(false) };
    let fg = foreground_info();
    Ok(json!({
        "secure_desktop": secure,
        "elevated_foreground": elevated,
        "foreground_exe": fg.exe,
        "foreground_title": fg.title,
        "foreground_rect": { "x": fg.rect.0, "y": fg.rect.1, "w": fg.rect.2, "h": fg.rect.3 },
        "foreground_pid": fg.pid,
    }))
}

/// Window-under-point exe (the elevation check for INPUT actions targets
/// what the CLICK will land in, not just the foreground).
pub fn window_under_point_exe(x: i32, y: i32) -> String {
    unsafe {
        let hwnd = WindowFromPoint(POINT { x, y });
        if hwnd.0.is_null() {
            return String::new();
        }
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        process_image_name(pid)
    }
}

/// ShellExecute open (computer_open).
pub fn shell_open(target: &str) -> Result<Value, HelperError> {
    let mut file: Vec<u16> = target.encode_utf16().chain(std::iter::once(0)).collect();
    let mut verb: Vec<u16> = "open".encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        let res = ShellExecuteW(None, pcwstr_or_empty(verb.as_mut_ptr()), pcwstr_or_empty(file.as_mut_ptr()), None, None, SW_SHOWNORMAL);
        let code = res.0 as usize;
        if code <= 32 {
            return Err(HelperError::internal(format!(
                "ShellExecuteW \"{target}\" failed (code {code}) — try the full app path or a URL"
            )));
        }
    }
    Ok(json!({ "ok": true }))
}

/// PCWSTR from a raw NUL-terminated buffer pointer (null-safe when empty).
fn pcwstr_or_empty(p: *mut u16) -> windows::core::PCWSTR {
    windows::core::PCWSTR(p)
}
