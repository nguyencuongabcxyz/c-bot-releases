//! The screens changing, a sleep and an unlock (main.js, the end of whenReady): a screen
//! added or taken away, a new resolution or scale, the taskbar moved: the robots are
//! refitted onto what's there now and anyone out for a walk comes back where you can reach
//! them; after a sleep or an unlock, the walkers too. Electron told of these as events;
//! here they're noticed by looking every couple of seconds (the screens' layout, whether
//! the desktop takes input, and the clock jumping ahead).

use std::thread;
use std::time::{Duration, SystemTime};

use tauri::AppHandle;
use windows_sys::core::BOOL;
use windows_sys::Win32::Foundation::{LPARAM, RECT};
use windows_sys::Win32::Graphics::Gdi::{EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO};
use windows_sys::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};

use crate::{revive, robots, walkers};

const EVERY: Duration = Duration::from_secs(2);
// a look that comes this late means the PC was asleep
const SLEPT: Duration = Duration::from_secs(30);
// after waking, give the screens a moment to come back (main.js's 1.5 s)
const SETTLE: Duration = Duration::from_millis(1500);

// (not in windows-sys's features this crate turns on)
#[link(name = "user32")]
unsafe extern "system" {
    fn OpenInputDesktop(flags: u32, inherit: BOOL, access: u32) -> *mut core::ffi::c_void;
    fn CloseDesktop(desktop: *mut core::ffi::c_void) -> BOOL;
}
const DESKTOP_SWITCHDESKTOP: u32 = 0x0100;

/// Each screen: where it is, where windows may go on it, and its scale.
type Layout = Vec<([i32; 4], [i32; 4], u32)>;

unsafe extern "system" fn add_monitor(hmon: HMONITOR, _dc: HDC, _rect: *mut RECT, data: LPARAM) -> BOOL {
    let layout = unsafe { &mut *(data as *mut Layout) };
    let mut info: MONITORINFO = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
    if unsafe { GetMonitorInfoW(hmon, &mut info) } != 0 {
        let (mut dx, mut dy) = (96u32, 96u32);
        unsafe { GetDpiForMonitor(hmon, MDT_EFFECTIVE_DPI, &mut dx, &mut dy) };
        let r = |r: RECT| [r.left, r.top, r.right, r.bottom];
        layout.push((r(info.rcMonitor), r(info.rcWork), dx));
    }
    1
}

fn layout() -> Layout {
    let mut layout: Layout = vec![];
    unsafe { EnumDisplayMonitors(std::ptr::null_mut(), std::ptr::null(), Some(add_monitor), &mut layout as *mut Layout as LPARAM) };
    layout.sort();
    layout
}

/// The desktop is locked (or the secure desktop is up): it doesn't take input.
pub fn locked() -> bool {
    unsafe {
        let desk = OpenInputDesktop(0, 0, DESKTOP_SWITCHDESKTOP);
        if desk.is_null() {
            return true;
        }
        CloseDesktop(desk);
        false
    }
}

fn after_wake(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || {
        thread::sleep(SETTLE);
        walkers::recover(&app);
        revive::nudge_all(&app); // (WebView2 can leave a window blank after a sleep)
    });
}

pub fn setup(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || {
        let mut screens = layout();
        let mut was_locked = locked();
        let mut last = SystemTime::now();
        loop {
            thread::sleep(EVERY);
            let now = SystemTime::now();
            let slept = now.duration_since(last).is_ok_and(|d| d > SLEPT);
            last = now;
            let is_locked = locked();
            let unlocked = was_locked && !is_locked;
            was_locked = is_locked;
            if slept || unlocked {
                after_wake(&app);
            }
            let fresh = layout();
            if fresh != screens && !fresh.is_empty() {
                screens = fresh;
                walkers::recover(&app);
                robots::refit(&app);
            }
        }
    });
}
