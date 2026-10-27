//! Keeping the PC awake: a Windows power request, held or let go. It keeps the display (and
//! the system) on; locking still locks. `powercfg /requests` shows it, with its reason.

use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::System::Power::{
    POWER_REQUEST_TYPE, PowerClearRequest, PowerCreateRequest, PowerRequestDisplayRequired,
    PowerRequestExecutionRequired, PowerRequestSystemRequired, PowerSetRequest,
};
use windows_sys::Win32::System::SystemServices::POWER_REQUEST_CONTEXT_VERSION;
use windows_sys::Win32::System::Threading::{POWER_REQUEST_CONTEXT_SIMPLE_STRING, REASON_CONTEXT};

const KINDS: [POWER_REQUEST_TYPE; 3] = [
    PowerRequestDisplayRequired,
    PowerRequestSystemRequired,
    PowerRequestExecutionRequired,
];

pub struct KeepAwake {
    request: HANDLE,
    held: bool,
    _reason: Vec<u16>, // (Windows keeps pointing at it)
}

// (the handle is only used from the thread that holds it, one call at a time)
unsafe impl Send for KeepAwake {}

impl KeepAwake {
    /// A request, not held yet; `reason` is what powercfg shows.
    pub fn new(reason: &str) -> Option<KeepAwake> {
        let mut reason: Vec<u16> = reason.encode_utf16().chain([0]).collect();
        let mut context = REASON_CONTEXT {
            Version: POWER_REQUEST_CONTEXT_VERSION,
            Flags: POWER_REQUEST_CONTEXT_SIMPLE_STRING,
            ..Default::default()
        };
        context.Reason.SimpleReasonString = reason.as_mut_ptr();
        // SAFETY: a filled-in context whose reason string outlives the request (kept in self).
        let request = unsafe { PowerCreateRequest(&context) };
        if request.is_null() || request as isize == -1 {
            return None;
        }
        Some(KeepAwake {
            request,
            held: false,
            _reason: reason,
        })
    }

    /// Hold it (the PC stays awake) or let it go.
    pub fn hold(&mut self, on: bool) {
        if on == self.held {
            return;
        }
        for kind in KINDS {
            // SAFETY: our own request handle.
            unsafe {
                if on {
                    PowerSetRequest(self.request, kind);
                } else {
                    PowerClearRequest(self.request, kind);
                }
            }
        }
        self.held = on;
    }
}
