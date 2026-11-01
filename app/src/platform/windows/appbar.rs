//! A window keeping a strip of its screen for itself, as the taskbar does (an app bar):
//! maximised windows stop beside it, and the screen's work area leaves it out.

use windows_sys::Win32::Foundation::{HWND, RECT};
use windows_sys::Win32::UI::Shell::{
    ABE_LEFT, ABE_RIGHT, ABM_NEW, ABM_QUERYPOS, ABM_REMOVE, ABM_SETPOS, APPBARDATA, SHAppBarMessage,
};
use windows_sys::Win32::UI::WindowsAndMessaging::WM_APP;

use crate::platform::common::types::Rect;

// what the shell tells the window of other bars coming and going (it has nothing to do with them)
const NEWS: u32 = WM_APP + 0x0B0;

fn data(hwnd: isize, left: bool, r: RECT) -> APPBARDATA {
    APPBARDATA {
        cbSize: std::mem::size_of::<APPBARDATA>() as u32,
        hWnd: hwnd as HWND,
        uCallbackMessage: NEWS,
        uEdge: if left { ABE_LEFT } else { ABE_RIGHT },
        rc: r,
        lParam: 0,
    }
}

/// Keep `w` px along the left (or right) edge of this screen for the window, its full height
/// (beside the taskbar, if that's on the same edge). Again with a new width: the strip follows.
pub fn reserve(hwnd: isize, left: bool, screen: Rect, w: i32) {
    let mut d = data(
        hwnd,
        left,
        RECT {
            left: if left { screen.x } else { screen.right() - w },
            top: screen.y,
            right: if left { screen.x + w } else { screen.right() },
            bottom: screen.bottom(),
        },
    );
    // SAFETY: d is a filled-in APPBARDATA of the right size, ours for the length of each call
    // (registering a window that's a bar already just fails, harmlessly).
    unsafe {
        SHAppBarMessage(ABM_NEW, &mut d);
        SHAppBarMessage(ABM_QUERYPOS, &mut d);
        // where the shell would have it (beside other bars), kept our width
        if left {
            d.rc.right = d.rc.left + w;
        } else {
            d.rc.left = d.rc.right - w;
        }
        SHAppBarMessage(ABM_SETPOS, &mut d);
    }
}

/// Its strip given back to the screen.
pub fn release(hwnd: isize) {
    let mut d = data(
        hwnd,
        true,
        RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        },
    );
    // SAFETY: as in reserve (removing a window that isn't a bar just fails).
    unsafe { SHAppBarMessage(ABM_REMOVE, &mut d) };
}
