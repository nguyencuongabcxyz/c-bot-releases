//! The screen as it is now (what desktopCapturer gave snip.js): one monitor, copied with
//! GDI, and the robot windows cloaked for a moment so they're not in the picture.

use image::RgbaImage;
use windows_sys::Win32::Foundation::{HWND, POINT};
use windows_sys::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_CLOAK};
use windows_sys::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits, GetMonitorInfoW, MonitorFromPoint, ReleaseDC, SelectObject,
    BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS, MONITORINFO, MONITOR_DEFAULTTONEAREST, SRCCOPY,
};
use windows_sys::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};

use crate::win::Rect;

/// A whole monitor (not just its work area: the box can go over the taskbar too) and its
/// scale.
#[derive(Clone, Copy, Debug)]
pub struct Screen {
    pub rect: Rect,
    pub scale: f64,
}

/// The monitor a point is on, or the nearest one.
pub fn screen_at(x: i32, y: i32) -> Screen {
    // SAFETY: MonitorFromPoint always gives a monitor (NEAREST); the info struct is sized.
    unsafe {
        let hmon = MonitorFromPoint(POINT { x, y }, MONITOR_DEFAULTTONEAREST);
        let mut info: MONITORINFO = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        GetMonitorInfoW(hmon, &mut info);
        let (mut dx, mut dy) = (96u32, 96u32);
        GetDpiForMonitor(hmon, MDT_EFFECTIVE_DPI, &mut dx, &mut dy);
        let r = info.rcMonitor;
        Screen { rect: Rect { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top }, scale: dx.max(1) as f64 / 96.0 }
    }
}

/// Hide a window from the screen without hiding it (DWM cloaking: its page keeps running
/// and nothing moves), or show it again.
pub fn cloak(hwnd: isize, on: bool) {
    let value: i32 = on as i32;
    // SAFETY: a BOOL-sized value for DWMWA_CLOAK on one of our own windows.
    unsafe { DwmSetWindowAttribute(hwnd as HWND, DWMWA_CLOAK as u32, &value as *const i32 as *const _, std::mem::size_of::<i32>() as u32) };
}

/// The pixels in that part of the screen (physical px), as they are now.
pub fn capture(r: Rect) -> Option<RgbaImage> {
    if r.w <= 0 || r.h <= 0 {
        return None;
    }
    let mut bgra = vec![0u8; r.w as usize * r.h as usize * 4];
    // SAFETY: GDI objects made here are selected out and freed before returning; the
    // buffer holds exactly w*h 32-bit pixels, as the BITMAPINFO asks for (top-down).
    let lines = unsafe {
        let screen = GetDC(std::ptr::null_mut());
        if screen.is_null() {
            return None;
        }
        let mem = CreateCompatibleDC(screen);
        let bmp = CreateCompatibleBitmap(screen, r.w, r.h);
        let old = SelectObject(mem, bmp);
        // (CAPTUREBLT: layered windows too, as you see them)
        let copied = BitBlt(mem, 0, 0, r.w, r.h, screen, r.x, r.y, SRCCOPY | CAPTUREBLT);
        SelectObject(mem, old);
        let mut info: BITMAPINFO = std::mem::zeroed();
        info.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: r.w,
            biHeight: -r.h,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB,
            ..std::mem::zeroed()
        };
        let lines = if copied != 0 { GetDIBits(mem, bmp, 0, r.h as u32, bgra.as_mut_ptr() as *mut _, &mut info, DIB_RGB_COLORS) } else { 0 };
        DeleteObject(bmp);
        DeleteDC(mem);
        ReleaseDC(std::ptr::null_mut(), screen);
        lines
    };
    if lines != r.h {
        return None;
    }
    for px in bgra.as_chunks_mut::<4>().0 {
        px.swap(0, 2);
        px[3] = 255;
    }
    RgbaImage::from_raw(r.w as u32, r.h as u32, bgra)
}

#[cfg(test)]
mod tests {
    use super::*;

    // (looks at the real screen, in memory only: run by hand with --ignored)
    #[test]
    #[ignore]
    fn captures_the_screen_under_a_point() {
        let s = screen_at(0, 0);
        assert!(s.rect.w > 0 && s.rect.h > 0 && s.scale >= 1.0);
        let img = capture(s.rect).expect("a capture");
        assert_eq!((img.width() as i32, img.height() as i32), (s.rect.w, s.rect.h));
        assert!(img.pixels().all(|p| p.0[3] == 255));
        assert!(capture(Rect { x: 0, y: 0, w: 0, h: 10 }).is_none());
    }
}
