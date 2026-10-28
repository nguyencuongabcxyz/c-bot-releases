//! The screen as it is now (what desktopCapturer gave snip.js): part of it copied with GDI,
//! and the robot windows cloaked for a moment so they're not in the picture. (Which screen:
//! window::monitor_near.)

use image::RgbaImage;
use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::Graphics::Dwm::{DWMWA_CLOAK, DwmSetWindowAttribute};
use windows_sys::Win32::Graphics::Gdi::{
    BI_RGB, BITMAPINFO, BITMAPINFOHEADER, BitBlt, CAPTUREBLT, CreateCompatibleBitmap,
    CreateCompatibleDC, DIB_RGB_COLORS, DeleteDC, DeleteObject, GetDC, GetDIBits, ReleaseDC,
    SRCCOPY, SelectObject,
};

use crate::platform::window::Rect;

/// Hide a window from the screen without hiding it (DWM cloaking: its page keeps running
/// and nothing moves), or show it again.
pub fn cloak(hwnd: isize, on: bool) {
    let value: i32 = on as i32;
    // SAFETY: a BOOL-sized value for DWMWA_CLOAK on one of our own windows.
    unsafe {
        DwmSetWindowAttribute(
            hwnd as HWND,
            DWMWA_CLOAK as u32,
            &value as *const i32 as *const _,
            std::mem::size_of::<i32>() as u32,
        )
    };
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
        let lines = if copied != 0 {
            GetDIBits(
                mem,
                bmp,
                0,
                r.h as u32,
                bgra.as_mut_ptr() as *mut _,
                &mut info,
                DIB_RGB_COLORS,
            )
        } else {
            0
        };
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
        let s = crate::platform::window::monitor_near(0, 0);
        assert!(s.bounds.w > 0 && s.bounds.h > 0 && s.scale >= 1.0);
        let img = capture(s.bounds).expect("a capture");
        assert_eq!(
            (img.width() as i32, img.height() as i32),
            (s.bounds.w, s.bounds.h)
        );
        assert!(img.pixels().all(|p| p.0[3] == 255));
        assert!(
            capture(Rect {
                x: 0,
                y: 0,
                w: 0,
                h: 10
            })
            .is_none()
        );
    }
}
