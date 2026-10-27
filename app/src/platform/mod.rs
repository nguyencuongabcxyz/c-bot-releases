//! What needs the operating system itself, kept by system:
//!   common/    what every system shares: types (Rect, Monitor, Key, Failure), and what's
//!              built the same everywhere on each system's own calls (input, image)
//!   windows/   Windows' own calls (Win32, WebView2)
//! (A macos/ or linux/ beside windows/ would offer the same modules with the same functions.)
//!
//! The rest of the app says platform::window, platform::input… and gets the one for the
//! system it's built for: `os` is that system's folder, re-exported here with common/.

mod common;
#[cfg(windows)]
mod windows;

#[cfg(windows)]
use windows as os;

pub use common::{image, input};
pub use os::{clipboard, power, presence, process, screenshot, webview, window};
