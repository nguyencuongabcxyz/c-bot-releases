//! What every system's platform modules share: plain types, nothing that calls the system.

/// A box on the screen, in physical pixels.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Rect {
    pub fn right(&self) -> i32 {
        self.x + self.w
    }
    pub fn bottom(&self) -> i32 {
        self.y + self.h
    }
    pub fn contains(&self, x: i32, y: i32) -> bool {
        x >= self.x && x < self.right() && y >= self.y && y < self.bottom()
    }
}

/// A screen: all of it (bounds), where windows may go on it (its work area, without the
/// taskbar) and its scale (1.0 at 100%).
#[derive(Clone, Copy, Debug)]
pub struct Monitor {
    pub bounds: Rect,
    pub work: Rect,
    pub scale: f64,
}

/// A key, whatever the system calls it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Key {
    Ctrl,
    Shift,
    Alt,
    /// The Windows key (Cmd on macOS, Super on Linux).
    Meta,
    Space,
    /// A letter (A–Z, upper case) or a digit.
    Char(char),
    /// F1–F24.
    F(u8),
}

/// How a page's process failed (a GPU process the browser engine restarts by itself: not one
/// of these).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    PageExited,
    PageUnresponsive,
    BrowserExited,
}

impl Failure {
    pub fn why(self) -> &'static str {
        match self {
            Failure::PageExited => "its page's process exited",
            Failure::PageUnresponsive => "its page stopped responding",
            Failure::BrowserExited => "the browser engine's process exited",
        }
    }
}
