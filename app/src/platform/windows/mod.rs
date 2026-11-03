//! Windows: straight through Win32 (windows-sys) and WebView2's COM interface.
//!
//!   appbar      a strip of the screen kept for a window, as the taskbar keeps its own
//!   window      windows and screens: place, show without the focus, on top, veiled; the
//!               screen a point is on, the cursor; other apps' windows (in front, titles)
//!   input       the keyboard and mouse: keys down, pressing keys, the last-input stamp
//!   clipboard   its text, pictures and files; saved and put back
//!   network     what Windows calls a network (Public or not), and links that open C-Bot
//!   explorer    an entry in Explorer's right-click menu on folders that opens C-Bot
//!   registry    this user's registry keys (for network and explorer)
//!   screenshot  the screen as it is now
//!   presence    presenting, focus assist, locked
//!   power       keeping the PC awake
//!   process     running a program without a window or in a terminal, ending a process tree
//!   webview     the browser engine under a window (WebView2)

pub mod appbar;
pub mod clipboard;
pub mod explorer;
pub mod input;
pub mod network;
pub mod power;
pub mod presence;
pub mod process;
mod registry;
pub mod screenshot;
pub mod webview;
pub mod window;
