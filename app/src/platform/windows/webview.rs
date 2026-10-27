//! The browser engine under a window: WebView2, through its COM interface (what Tauri doesn't
//! wrap): hearing that a page's process failed, and nudging a page that stopped drawing
//! (robots/revive.rs).

use tauri::WebviewWindow;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_PROCESS_FAILED_KIND, COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED,
    COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
    COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE,
};
use webview2_com::ProcessFailedEventHandler;

pub use crate::platform::common::types::Failure;

/// Call `then` (on the window's thread) whenever its page's process fails.
pub fn on_process_failed(window: &WebviewWindow, then: impl Fn(Failure) + Send + 'static) {
    // SAFETY: WebView2 COM calls on the window's own controller, on its thread (with_webview).
    let _ = window.with_webview(move |wv| unsafe {
        let Ok(core) = wv.controller().CoreWebView2() else {
            return;
        };
        let handler = ProcessFailedEventHandler::create(Box::new(move |_, args| {
            let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
            if let Some(args) = args {
                let _ = args.ProcessFailedKind(&mut kind);
            }
            let failure = match kind {
                COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED => Failure::PageExited,
                COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE => {
                    Failure::PageUnresponsive
                }
                COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED => Failure::BrowserExited,
                _ => return Ok(()),
            };
            then(failure);
            Ok(())
        }));
        let mut token = 0i64;
        let _ = core.add_ProcessFailed(&handler, &mut token);
    });
}

/// Tell the webview it's hidden and shown again: WebView2 works out afresh whether it's on
/// screen, and draws it (it can miss that after a sleep, and leave the window blank).
pub fn nudge(window: &WebviewWindow) {
    // SAFETY: WebView2 COM calls on the window's own controller, on its thread (with_webview).
    let _ = window.with_webview(|wv| unsafe {
        let c = wv.controller();
        let _ = c.SetIsVisible(false);
        let _ = c.SetIsVisible(true);
        let _ = c.NotifyParentWindowPositionChanged();
    });
}
