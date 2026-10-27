//! What you're up to, as Windows sees it (main reminders.js presenting / acceptsNotifications):
//! presenting or full screen, so the robots keep quiet; in quiet hours / focus assist; or
//! away, with the PC locked.

use windows_sys::Win32::UI::Shell::SHQueryUserNotificationState;

/// Windows' SHQueryUserNotificationState (QUNS_*), or 0 when it can't tell.
fn notification_state() -> i32 {
    let mut state = 0;
    // SAFETY: somewhere to put the state.
    match unsafe { SHQueryUserNotificationState(&mut state) } {
        0 => state,
        _ => 0,
    }
}

/// You're presenting, or a full-screen app or game has the screen (QUNS_BUSY,
/// QUNS_RUNNING_D3D_FULL_SCREEN, QUNS_PRESENTATION_MODE).
pub fn presenting() -> bool {
    matches!(notification_state(), 2..=4)
}

// (not in windows-sys's features this crate turns on)
#[link(name = "user32")]
unsafe extern "system" {
    fn OpenInputDesktop(flags: u32, inherit: i32, access: u32) -> *mut core::ffi::c_void;
    fn CloseDesktop(desktop: *mut core::ffi::c_void) -> i32;
}
const DESKTOP_SWITCHDESKTOP: u32 = 0x0100;

/// The desktop is locked (or the secure desktop is up): it doesn't take input.
pub fn locked() -> bool {
    // SAFETY: plain calls; the desktop handle is closed again straight away.
    unsafe {
        let desk = OpenInputDesktop(0, 0, DESKTOP_SWITCHDESKTOP);
        if desk.is_null() {
            return true;
        }
        CloseDesktop(desk);
        false
    }
}

/// Windows would show a notification now (not in quiet hours / focus assist):
/// QUNS_ACCEPTS_NOTIFICATIONS, or it can't tell.
pub fn accepts_notifications() -> bool {
    matches!(notification_state(), 0 | 5)
}
