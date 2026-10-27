//! While a conversation has Remote Control on, the PC stays awake. On a laptop like this
//! (Modern Standby), the screen going off by itself counts as going to sleep, and Windows then
//! freezes C-Bot and its Claude Code: claude.ai and the Claude app would lose the robot a few
//! minutes after you lock the PC and walk away. So C-Bot asks Windows to keep the display
//! (and the system) on; locking still locks. `powercfg /requests` shows why it's awake.

use std::thread;
use std::time::Duration;

use tauri::AppHandle;
use windows_sys::Win32::System::Power::{
    PowerClearRequest, PowerCreateRequest, PowerRequestDisplayRequired, PowerRequestExecutionRequired, PowerRequestSystemRequired, PowerSetRequest,
    POWER_REQUEST_TYPE,
};
use windows_sys::Win32::System::SystemServices::POWER_REQUEST_CONTEXT_VERSION;
use windows_sys::Win32::System::Threading::{POWER_REQUEST_CONTEXT_SIMPLE_STRING, REASON_CONTEXT};

use crate::with;

const EVERY: Duration = Duration::from_secs(5);
const KINDS: [POWER_REQUEST_TYPE; 3] = [PowerRequestDisplayRequired, PowerRequestSystemRequired, PowerRequestExecutionRequired];

pub fn setup(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || {
        let mut reason: Vec<u16> = "C-Bot: Remote Control is on".encode_utf16().chain([0]).collect();
        let mut context = REASON_CONTEXT { Version: POWER_REQUEST_CONTEXT_VERSION, Flags: POWER_REQUEST_CONTEXT_SIMPLE_STRING, ..Default::default() };
        context.Reason.SimpleReasonString = reason.as_mut_ptr();
        let request = unsafe { PowerCreateRequest(&context) };
        if request.is_null() || request as isize == -1 {
            eprintln!("[awake] couldn't make a power request");
            return;
        }
        let mut held = false;
        loop {
            let wanted = with(&app, |st| st.chats.values().any(|c| c.session.remote()));
            if wanted != held {
                for kind in KINDS {
                    unsafe {
                        if wanted {
                            PowerSetRequest(request, kind);
                        } else {
                            PowerClearRequest(request, kind);
                        }
                    }
                }
                held = wanted;
            }
            thread::sleep(EVERY);
        }
    });
}
