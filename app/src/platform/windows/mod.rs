//! Windows: straight through Win32 (windows-sys) and WebView2's COM interface.
//!
//!   window      windows and screens: place, show without the focus, on top, veiled; the
//!               screen a point is on, the cursor; other apps' windows (in front, titles)
//!   input       the keyboard and mouse: keys down, pressing keys, the last-input stamp
//!   clipboard   its text, pictures and files; saved and put back
//!   screenshot  the screen as it is now
//!   presence    presenting, focus assist, locked
//!   power       keeping the PC awake
//!   process     running a program without a window or in a terminal, ending a process tree
//!   webview     the browser engine under a window (WebView2)

pub mod clipboard;
pub mod input;
pub mod power;
pub mod presence;
pub mod process;
pub mod screenshot;
pub mod webview;
pub mod window;
