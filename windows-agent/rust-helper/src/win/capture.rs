//! Screen capture (Windows-only): Windows Graphics Capture as the primary
//! path + GDI BitBlt as the fallback when WGC init fails (preserves the W1
//! behavior exactly). Returns raw BGRA + dims; the AGENT keeps JPEG encoding
//! (jpeg-js) — the helper never encodes images.

use crate::protocol::*;
use serde_json::{json, Value};
use windows::core::Interface;
use windows::Graphics::Capture::Direct3D11CaptureFramePool;
use windows::Graphics::Capture::GraphicsCaptureItem;
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Win32::Foundation::{HMODULE, LPARAM, POINT, RECT};
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::System::WinRT::Direct3D11::CreateDirect3D11DeviceFromDXGIDevice;
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, SetProcessDPIAware, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN,
    SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
};
// EnumDisplayMonitors + MONITORENUMPROC live in Gdi (winuser re-export path
// in windows-rs 0.62) — pulled in by the Gdi glob above, disambiguated here.
use windows::Win32::Graphics::Gdi::{EnumDisplayMonitors, MONITORENUMPROC};

// ── Virtual-screen metrics (shared by both capture paths + geometry) ─────────

pub fn virtual_screen_metrics() -> Result<(i32, i32), HelperError> {
    unsafe {
        let w = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        let h = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        if w <= 0 || h <= 0 {
            return Err(HelperError::internal("virtual screen metrics unavailable (locked session?)"));
        }
        Ok((w, h))
    }
}

fn virtual_screen_origin() -> (i32, i32) {
    unsafe { (GetSystemMetrics(SM_XVIRTUALSCREEN), GetSystemMetrics(SM_YVIRTUALSCREEN)) }
}

/// A completed capture: BGRA bytes base64 + dims + which backend produced it
/// + the virtual-screen origin the capture covers (for multi-monitor mapping)
/// + the helper-side DRM heuristic verdict (uniform-black foreground rect).
pub struct CaptureHandle {
    pub bgra_b64: String,
    pub width: i32,
    pub height: i32,
    pub backend: &'static str,
    pub vx: i32,
    pub vy: i32,
    pub drm_suspected: bool,
}

/// The raw capture before encoding (capture_once adds base64 + the DRM flag).
struct RawCapture {
    pixels: Vec<u8>,
    width: i32,
    height: i32,
    backend: &'static str,
    vx: i32,
    vy: i32,
}

// ── The capture path: WGC first, GDI fallback ───────────────────────────────

pub fn capture_once() -> Result<CaptureHandle, HelperError> {
    // Secure-desktop preflight (shared with the input path): if a UAC prompt
    // or lock screen is up, capture is refused with the frozen code rather
    // than a confusing WGC/GDI failure.
    if crate::win::env::secure_desktop_active()? {
        return Err(HelperError::refuse(UIA_E_SECURE_DESKTOP));
    }
    let raw = match wgc_capture() {
        Ok(h) => h,
        Err(e) => {
            // WGC unavailable (pre-1903 OS, no D3D11, interop refusal — a
            // warning-grade failure) → fall back to the EXACT W1 GDI path.
            eprintln!("[helper] WGC capture unavailable ({e}) — falling back to GDI BitBlt");
            gdi_capture()?
        }
    };
    // DRM heuristic (frame-side): a uniform-black FOREGROUND-WINDOW rect in
    // the captured frame → the UIA_W_DRM_SUSPECTED warning. Computed HERE so
    // the agent gets it in the same response (no extra round-trip); the
    // agent keeps its own copy as the fallback for older helpers/tests.
    let fg_rect = crate::win::env::foreground_rect();
    let drm = crate::drm::drm_suspected(&crate::drm::FrameProbe {
        pixels: &raw.pixels,
        width: raw.width as usize,
        height: raw.height as usize,
        rect: fg_rect,
        vx: raw.vx,
        vy: raw.vy,
    });
    Ok(CaptureHandle {
        bgra_b64: base64_encode(&raw.pixels),
        width: raw.width,
        height: raw.height,
        backend: raw.backend,
        vx: raw.vx,
        vy: raw.vy,
        drm_suspected: drm,
    })
}

// ── GDI BitBlt fallback — the verbatim W1 path (win32.ts captureJpeg) ────────

fn gdi_capture() -> Result<RawCapture, HelperError> {
    unsafe {
        let (vx, vy) = virtual_screen_origin();
        let (width, height) = virtual_screen_metrics()?;
        let hdc_screen = GetDC(None);
        if hdc_screen.is_invalid() {
            return Err(HelperError::refuse(UIA_E_SECURE_DESKTOP));
        }
        let hdc_mem = CreateCompatibleDC(Some(hdc_screen));
        if hdc_mem.is_invalid() {
            ReleaseDC(None, hdc_screen);
            return Err(HelperError::internal("CreateCompatibleDC failed"));
        }
        let hbm = CreateCompatibleBitmap(hdc_screen, width, height);
        if hbm.is_invalid() {
            let _ = DeleteDC(hdc_mem);
            ReleaseDC(None, hdc_screen);
            return Err(HelperError::internal("CreateCompatibleBitmap failed"));
        }
        let old = SelectObject(hdc_mem, HGDIOBJ(hbm.0));
        if BitBlt(hdc_mem, 0, 0, width, height, Some(hdc_screen), vx, vy, SRCCOPY).is_err() {
            SelectObject(hdc_mem, old);
            let _ = DeleteObject(HGDIOBJ(hbm.0));
            let _ = DeleteDC(hdc_mem);
            ReleaseDC(None, hdc_screen);
            return Err(HelperError::refuse(UIA_E_DRM));
        }
        // BITMAPINFO: top-down 32bpp BGRA.
        let mut bi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height, // negative = top-down
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut pixels: Vec<u8> = vec![0; (width as usize) * (height as usize) * 4];
        let got = GetDIBits(
            hdc_mem,
            hbm,
            0,
            height as u32,
            Some(pixels.as_mut_ptr().cast()),
            &mut bi,
            DIB_RGB_COLORS,
        );
        SelectObject(hdc_mem, old);
        let _ = DeleteObject(HGDIOBJ(hbm.0));
        let _ = DeleteDC(hdc_mem);
        ReleaseDC(None, hdc_screen);
        if got == 0 {
            return Err(HelperError::internal("GetDIBits failed"));
        }
        Ok(RawCapture { pixels, width, height, backend: "gdi", vx, vy })
    }
}

// ── WGC (Windows Graphics Capture) — the W3 production path ─────────────────

/// One-shot WGC capture of the primary monitor: D3D11 device → DXGI cast →
/// IDirect3DDevice → GraphicsCaptureItem via IGraphicsCaptureItemInterop::
/// CreateForMonitor → FramePool::Create → one frame → staging texture →
/// CPU map → BGRA Vec.
fn wgc_capture() -> Result<RawCapture, HelperError> {
    unsafe {
        let _ = SetProcessDPIAware();

        // 1. D3D11 device on the default adapter (BGRA support flag — WGC's
        //    frame format is B8G8R8A8).
        let mut d3d_device: Option<ID3D11Device> = None;
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            None,
            D3D11_SDK_VERSION,
            Some(&mut d3d_device),
            None,
            None,
        )
        .map_err(|e| HelperError::internal(format!("D3D11CreateDevice failed: {e}")))?;
        let device = d3d_device.ok_or_else(|| HelperError::internal("D3D11CreateDevice returned no device"))?;

        // 2. Direct3D11 device for WinRT.
        let dxgi: IDXGIDevice = device
            .cast()
            .map_err(|e| HelperError::internal(format!("ID3D11Device cast to IDXGIDevice failed: {e}")))?;
        let inspectable = CreateDirect3D11DeviceFromDXGIDevice(&dxgi)
            .map_err(|e| HelperError::internal(format!("CreateDirect3D11DeviceFromDXGIDevice failed: {e}")))?;
        let d3d_winrt: IDirect3DDevice = inspectable
            .cast()
            .map_err(|e| HelperError::internal(format!("IInspectable cast to IDirect3DDevice failed: {e}")))?;

        // 3. GraphicsCaptureItem for the primary monitor.
        let interop: IGraphicsCaptureItemInterop = windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()
            .map_err(|e| HelperError::internal(format!("IGraphicsCaptureItemInterop activation failed: {e}")))?;
        let primary = MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY);
        let item: GraphicsCaptureItem = interop
            .CreateForMonitor(primary)
            .map_err(|e| HelperError::internal(format!("CreateForMonitor failed: {e}")))?;
        let size = item
            .Size()
            .map_err(|e| HelperError::internal(format!("GraphicsCaptureItem::Size failed: {e}")))?;

        // MULTI-MONITOR GUARD (review B2): WGC captures ONE monitor (the
        // primary), but the agent's geometry contract is the ENTIRE virtual
        // screen (W1 captured it all — the GDI fallback still does). Using a
        // primary-only frame with virtual-screen metrics makes the agent's
        // aspect-drift check (>2%) refuse every coordinate action on any
        // multi-monitor layout. So: WGC only when the primary monitor IS the
        // whole virtual screen; otherwise fall back to GDI via an error
        // (capture_once's fallback path). Per-monitor WGC composition is W4.
        let (vw, vh) = virtual_screen_metrics()?;
        if size.Width != vw || size.Height != vh {
            return Err(HelperError::internal(format!(
                "multi-monitor layout (primary {w0}x{h0} != virtual {vw}x{vh}) — GDI captures the full virtual screen",
                w0 = size.Width, h0 = size.Height,
            )));
        }

        // 4. FramePool + one frame (bounded wait — the compositor hands us a
        //    frame within ~one frame interval on a live display).
        let pool = Direct3D11CaptureFramePool::Create(&d3d_winrt, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, size)
            .map_err(|e| HelperError::internal(format!("FramePool::Create failed: {e}")))?;
        let session = pool
            .CreateCaptureSession(&item)
            .map_err(|e| HelperError::internal(format!("CreateCaptureSession failed: {e}")))?;
        session
            .StartCapture()
            .map_err(|e| HelperError::internal(format!("StartCapture failed: {e}")))?;
        let frame = wait_for_frame(&pool)?;

        // 5. Surface → staging texture → Map → BGRA copy.
        let surface = frame
            .Surface()
            .map_err(|e| HelperError::internal(format!("frame Surface failed: {e}")))?;
        let access = surface
            .cast::<windows::Win32::System::WinRT::Direct3D11::IDirect3DDxgiInterfaceAccess>()
            .map_err(|e| HelperError::internal(format!("surface cast to IDirect3DDxgiInterfaceAccess failed: {e}")))?;
        let texture: ID3D11Texture2D = access
            .GetInterface()
            .map_err(|e| HelperError::internal(format!("DxgiInterfaceAccess::GetInterface failed: {e}")))?;
        let desc: D3D11_TEXTURE2D_DESC = {
            let mut d = D3D11_TEXTURE2D_DESC::default();
            texture.GetDesc(&mut d);
            d
        };
        let staging_desc = D3D11_TEXTURE2D_DESC {
            Width: desc.Width,
            Height: desc.Height,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_STAGING,
            BindFlags: 0,
            CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
            MiscFlags: 0,
        };
        let mut staging: Option<ID3D11Texture2D> = None;
        device
            .CreateTexture2D(&staging_desc, None, Some(&mut staging))
            .map_err(|e| HelperError::internal(format!("CreateTexture2D(staging) failed: {e}")))?;
        let staging = staging.ok_or_else(|| HelperError::internal("CreateTexture2D returned no texture"))?;
        let ctx = device
            .GetImmediateContext()
            .map_err(|e| HelperError::internal(format!("GetImmediateContext failed: {e}")))?;
        ctx.CopyResource(&staging, &texture);
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        ctx.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
            .map_err(|e| HelperError::internal(format!("staging Map failed: {e}")))?;
        let w = desc.Width as usize;
        let h = desc.Height as usize;
        let mut pixels: Vec<u8> = vec![0; w * h * 4];
        let src = mapped.pData as *const u8;
        let pitch = mapped.RowPitch as usize;
        for row in 0..h {
            std::ptr::copy_nonoverlapping(src.add(row * pitch), pixels.as_mut_ptr().add(row * w * 4), w * 4);
        }
        ctx.Unmap(&staging, 0);

        let (vx, vy) = virtual_screen_origin();
        Ok(RawCapture { pixels, width: w as i32, height: h as i32, backend: "wgc", vx, vy })
    }
}

fn wait_for_frame(pool: &Direct3D11CaptureFramePool) -> Result<windows::Graphics::Capture::Direct3D11CaptureFrame, HelperError> {
    // Bounded spin: TryGetNextFrame returns Err until the compositor hands
    // us a frame (~1 frame interval, ≤ a few hundred ms on any live display).
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(700);
    loop {
        match pool.TryGetNextFrame() {
            Ok(f) => return Ok(f),
            Err(_) => {}
        }
        if std::time::Instant::now() > deadline {
            return Err(HelperError::internal("WGC frame wait timed out (700ms)"));
        }
        std::thread::sleep(std::time::Duration::from_millis(15));
    }
}

/// Full virtual-screen geometry snapshot (per-monitor rects + DPI) — the W1
/// contract shape the agent's foldOrigin expects (null when unavailable).
pub fn geometry_snapshot() -> Result<Value, HelperError> {
    unsafe {
        let _ = SetProcessDPIAware();
        let x = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let y = GetSystemMetrics(SM_YVIRTUALSCREEN);
        let width = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        let height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        if width <= 0 || height <= 0 {
            return Ok(Value::Null);
        }

        struct Ctx {
            list: Vec<Value>,
        }
        let mut ctx = Ctx { list: Vec::new() };
        unsafe impl Send for Ctx {}
        extern "system" fn enum_proc(hmon: HMONITOR, _hdc: HDC, _rect: *mut RECT, data: LPARAM) -> windows::core::BOOL {
            let ctx = unsafe { &mut *(data.0 as *mut Ctx) };
            let mut mi = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
            if unsafe { GetMonitorInfoW(hmon, &mut mi) }.as_bool() {
                let (x, y) = (mi.rcMonitor.left, mi.rcMonitor.top);
                let (w, h) = (mi.rcMonitor.right - x, mi.rcMonitor.bottom - y);
                // Per-monitor DPI via a screen DC (LOGPIXELSX is DPI-virtualized
                // per the process DPI awareness; SetProcessDPIAware was called).
                let hdc = unsafe { GetDC(None) };
                let dpi = if hdc.is_invalid() {
                    96
                } else {
                    let d = unsafe { GetDeviceCaps(Some(hdc), LOGPIXELSX) };
                    unsafe { ReleaseDC(None, hdc) };
                    if d > 0 { d } else { 96 }
                };
                ctx.list.push(serde_json::json!({ "x": x, "y": y, "width": w, "height": h, "dpi": dpi }));
            }
            windows::core::BOOL(1)
        }
        let proc: MONITORENUMPROC = Some(enum_proc);
        let _ = EnumDisplayMonitors(None, None, proc, LPARAM(&mut ctx as *mut _ as isize));
        Ok(json!({ "x": x, "y": y, "width": width, "height": height, "monitors": ctx.list }))
    }
}

// base64 (the base64 crate).
fn base64_encode(data: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(data)
}
