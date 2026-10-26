//! The few Win32 calls the robot windows need, made straight to Windows: they work from
//! any thread without a round trip through the event loop (Tauri's own getters wait on
//! the main thread). Positions are physical pixels; the app is per-monitor DPI aware.

use windows_sys::Win32::Foundation::{HWND, POINT, RECT};
use windows_sys::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTONEAREST, MONITOR_DEFAULTTOPRIMARY};
use windows_sys::Win32::UI::HiDpi::{GetDpiForMonitor, GetDpiForWindow, MDT_EFFECTIVE_DPI};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetWindowRect, IsWindowVisible, SetWindowPos, SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER,
};

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Rect {
    pub fn right(&self) -> i32 {
        self.x + self.w
    }
    pub fn bottom(&self) -> i32 {
        self.y + self.h
    }
    pub fn contains(&self, x: i32, y: i32) -> bool {
        x >= self.x && x < self.right() && y >= self.y && y < self.bottom()
    }
}

fn rect(r: RECT) -> Rect {
    Rect { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top }
}

/// A screen: where windows may go on it (its work area, without the taskbar) and its
/// scale (1.0 at 100%).
#[derive(Clone, Copy, Debug)]
pub struct Monitor {
    pub work: Rect,
    pub scale: f64,
}

fn monitor(flags: u32, x: i32, y: i32) -> Monitor {
    unsafe {
        let hmon = MonitorFromPoint(POINT { x, y }, flags);
        let mut info: MONITORINFO = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        GetMonitorInfoW(hmon, &mut info);
        let (mut dx, mut dy) = (96u32, 96u32);
        GetDpiForMonitor(hmon, MDT_EFFECTIVE_DPI, &mut dx, &mut dy);
        Monitor { work: rect(info.rcWork), scale: dx as f64 / 96.0 }
    }
}

/// The screen a point is on, or the nearest one (as Electron's getDisplayNearestPoint).
pub fn monitor_near(x: i32, y: i32) -> Monitor {
    monitor(MONITOR_DEFAULTTONEAREST, x, y)
}

pub fn primary_monitor() -> Monitor {
    monitor(MONITOR_DEFAULTTOPRIMARY, 0, 0)
}

pub fn cursor() -> (i32, i32) {
    let mut p = POINT { x: 0, y: 0 };
    unsafe { GetCursorPos(&mut p) };
    (p.x, p.y)
}

pub fn window_rect(hwnd: isize) -> Rect {
    let mut r: RECT = unsafe { std::mem::zeroed() };
    unsafe { GetWindowRect(hwnd as HWND, &mut r) };
    rect(r)
}

pub fn is_visible(hwnd: isize) -> bool {
    unsafe { IsWindowVisible(hwnd as HWND) != 0 }
}

/// The window's scale (its screen's, once Windows has moved it there).
pub fn scale_of(hwnd: isize) -> f64 {
    match unsafe { GetDpiForWindow(hwnd as HWND) } {
        0 => 1.0,
        dpi => dpi as f64 / 96.0,
    }
}

/// Place and size it in one go (two calls would show a frame in between), without
/// bringing it forward.
pub fn set_bounds(hwnd: isize, r: Rect) {
    unsafe { SetWindowPos(hwnd as HWND, std::ptr::null_mut(), r.x, r.y, r.w, r.h, SWP_NOZORDER | SWP_NOACTIVATE) };
}

pub fn set_position(hwnd: isize, x: i32, y: i32) {
    unsafe { SetWindowPos(hwnd as HWND, std::ptr::null_mut(), x, y, 0, 0, SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOSIZE) };
}
