//! Windows and screens through Win32: placing, showing without the focus, keeping on top,
//! veiling; the screen a point is on, the cursor; and other apps' windows (in front, their
//! titles). Straight to Windows, so they work from any thread without a round trip through
//! the event loop (Tauri's own getters wait on the main thread).

use windows_sys::Win32::Foundation::{HWND, POINT, RECT};
use windows_sys::Win32::Graphics::Gdi::{
    CreateRectRgn, GetMonitorInfoW, GetWindowRgnBox, MONITOR_DEFAULTTONEAREST,
    MONITOR_DEFAULTTOPRIMARY, MONITORINFO, MonitorFromPoint, RGN_ERROR, SetWindowRgn,
};
use windows_sys::Win32::UI::HiDpi::{GetDpiForMonitor, GetDpiForWindow, MDT_EFFECTIVE_DPI};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GWL_EXSTYLE, GetCursorPos, GetForegroundWindow, GetSystemMetrics, GetWindowLongPtrW,
    GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, HWND_TOPMOST, IsWindow,
    IsWindowVisible, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
    SW_HIDE, SW_SHOWNOACTIVATE, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOOWNERZORDER, SWP_NOSIZE,
    SWP_NOZORDER, SetForegroundWindow, SetWindowPos, ShowWindow, WS_EX_TOPMOST,
};

pub use crate::platform::common::types::Monitor;
pub use crate::platform::common::types::Rect;

fn rect(r: RECT) -> Rect {
    Rect {
        x: r.left,
        y: r.top,
        w: r.right - r.left,
        h: r.bottom - r.top,
    }
}

fn monitor(flags: u32, x: i32, y: i32) -> Monitor {
    // SAFETY: MonitorFromPoint always gives a monitor (the flags pick one); info and the dpi
    // are ours to fill, info's size set first.
    unsafe {
        let hmon = MonitorFromPoint(POINT { x, y }, flags);
        let mut info: MONITORINFO = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        GetMonitorInfoW(hmon, &mut info);
        let (mut dx, mut dy) = (96u32, 96u32);
        GetDpiForMonitor(hmon, MDT_EFFECTIVE_DPI, &mut dx, &mut dy);
        Monitor {
            bounds: rect(info.rcMonitor),
            work: rect(info.rcWork),
            scale: dx as f64 / 96.0,
        }
    }
}

/// The screen a point is on, or the nearest one (as Electron's getDisplayNearestPoint).
pub fn monitor_near(x: i32, y: i32) -> Monitor {
    monitor(MONITOR_DEFAULTTONEAREST, x, y)
}

pub fn primary_monitor() -> Monitor {
    monitor(MONITOR_DEFAULTTOPRIMARY, 0, 0)
}

/// All the screens together (the virtual screen).
pub fn all_screens() -> Rect {
    // SAFETY: plain metrics.
    unsafe {
        Rect {
            x: GetSystemMetrics(SM_XVIRTUALSCREEN),
            y: GetSystemMetrics(SM_YVIRTUALSCREEN),
            w: GetSystemMetrics(SM_CXVIRTUALSCREEN),
            h: GetSystemMetrics(SM_CYVIRTUALSCREEN),
        }
    }
}

pub fn cursor() -> (i32, i32) {
    let mut p = POINT { x: 0, y: 0 };
    // SAFETY: only writes the position into p.
    unsafe { GetCursorPos(&mut p) };
    (p.x, p.y)
}

pub fn window_rect(hwnd: isize) -> Rect {
    let mut r = RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    // SAFETY: only writes the window's rect into r (a stale handle just fails).
    unsafe { GetWindowRect(hwnd as HWND, &mut r) };
    rect(r)
}

pub fn is_visible(hwnd: isize) -> bool {
    // SAFETY: a plain call on a window handle.
    unsafe { IsWindowVisible(hwnd as HWND) != 0 }
}

/// The window's scale (its screen's, once Windows has moved it there).
pub fn scale_of(hwnd: isize) -> f64 {
    // SAFETY: a plain call on a window handle (a stale one gives 0).
    match unsafe { GetDpiForWindow(hwnd as HWND) } {
        0 => 1.0,
        dpi => dpi as f64 / 96.0,
    }
}

/// Place and size it in one go (two calls would show a frame in between), without
/// bringing it forward.
pub fn set_bounds(hwnd: isize, r: Rect) {
    // SAFETY: a plain call on a window handle.
    unsafe {
        SetWindowPos(
            hwnd as HWND,
            std::ptr::null_mut(),
            r.x,
            r.y,
            r.w,
            r.h,
            SWP_NOZORDER | SWP_NOACTIVATE,
        )
    };
}

pub fn set_position(hwnd: isize, x: i32, y: i32) {
    // SAFETY: a plain call on a window handle.
    unsafe {
        SetWindowPos(
            hwnd as HWND,
            std::ptr::null_mut(),
            x,
            y,
            0,
            0,
            SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOSIZE,
        )
    };
}

/// Shown without taking the focus from the app you're in.
pub fn show_no_activate(hwnd: isize) {
    // SAFETY: a plain call on a window handle (a stale one just fails).
    unsafe { ShowWindow(hwnd as HWND, SW_SHOWNOACTIVATE) };
}

pub fn hide(hwnd: isize) {
    // SAFETY: a plain call on a window handle.
    unsafe { ShowWindow(hwnd as HWND, SW_HIDE) };
}

/// Back on top of the other always-on-top windows, without taking the focus.
pub fn set_topmost(hwnd: isize) {
    // SAFETY: a plain call on a window handle.
    unsafe {
        SetWindowPos(
            hwnd as HWND,
            HWND_TOPMOST,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        )
    };
}

/// Back on top if it's showing and lost its "always on top" flag (and only then: it never
/// fights another always-on-top window for the top).
pub fn restore_topmost(hwnd: isize) {
    // SAFETY: plain calls on a window handle (a stale one just fails).
    unsafe {
        let h = hwnd as HWND;
        if IsWindowVisible(h) == 0 || GetWindowLongPtrW(h, GWL_EXSTYLE) as u32 & WS_EX_TOPMOST != 0
        {
            return;
        }
        SetWindowPos(
            h,
            HWND_TOPMOST,
            0,
            0,
            0,
            0,
            SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
        );
    }
}

/// Veiled, or not: an empty window region draws nothing and takes no clicks, while the
/// window itself stays shown (none: the whole window). Call it on the window's own thread.
pub fn set_veiled(hwnd: isize, veiled: bool) {
    // SAFETY: plain calls on our own window; once set, the region belongs to the system.
    unsafe {
        let rgn = if veiled {
            CreateRectRgn(0, 0, 0, 0)
        } else {
            std::ptr::null_mut()
        };
        SetWindowRgn(hwnd as HWND, rgn, 1);
    }
}

/// Is it veiled (any window region at all)?
pub fn is_veiled(hwnd: isize) -> bool {
    let mut r = RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    // SAFETY: only reads the window's region box into r.
    unsafe { GetWindowRgnBox(hwnd as HWND, &mut r) != RGN_ERROR }
}

/// The window in front (0: none).
pub fn foreground() -> isize {
    // SAFETY: plain Win32 call.
    unsafe { GetForegroundWindow() as isize }
}

/// Is that still a window?
pub fn is_window(hwnd: isize) -> bool {
    // SAFETY: IsWindow takes any value and says whether it's a window.
    hwnd != 0 && unsafe { IsWindow(hwnd as HWND) } != 0
}

/// Bring it in front (fails harmlessly if it's gone).
pub fn bring_to_front(hwnd: isize) {
    // SAFETY: a plain call on a window handle (a stale one just fails).
    unsafe { SetForegroundWindow(hwnd as HWND) };
}

/// The process a window belongs to (0 if it's gone).
pub fn process_of(hwnd: isize) -> u32 {
    let mut pid = 0u32;
    // SAFETY: a window handle (possibly stale: then it fails) and somewhere to put the id.
    unsafe { GetWindowThreadProcessId(hwnd as HWND, &mut pid) };
    pid
}

/// A window's title.
pub fn title_of(hwnd: isize) -> String {
    let mut buf = [0u16; 512];
    // SAFETY: the buffer and its length in UTF-16 units.
    let n = unsafe { GetWindowTextW(hwnd as HWND, buf.as_mut_ptr(), buf.len() as i32) };
    String::from_utf16_lossy(&buf[..n.clamp(0, buf.len() as i32) as usize])
}
