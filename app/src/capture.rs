//! Global hotkeys that grab something from whatever app you're in, and the rest of what
//! needs Windows itself (main capture.js, reminders.js presenting / acceptsNotifications):
//! the selected text (copied out with a simulated Ctrl+C, the clipboard put back after),
//! pasting back over it, the title of the app in front, and whether you're presenting.
//! [wave 1: input]

pub mod clip;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use tauri::AppHandle;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VK_C, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT, VK_V,
};
use windows_sys::Win32::UI::Shell::SHQueryUserNotificationState;
use windows_sys::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId, IsWindow, SetForegroundWindow};

/// What was selected in the app in front when a hotkey went: its text, that app's window
/// title, and its window (to paste a result back into).
#[derive(Clone, Debug, Default)]
pub struct Selection {
    pub text: String,
    pub source: String,
    pub hwnd: isize,
}

// ---------------------------------------------------------------- hotkeys

/// The hotkeys bound, by name (their setting), to unbind one when it changes.
fn bound() -> &'static Mutex<HashMap<String, Shortcut>> {
    static BOUND: OnceLock<Mutex<HashMap<String, Shortcut>>> = OnceLock::new();
    BOUND.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The key of an Electron accelerator ("W", "Space", "F5", "Plus", "num4"…) as the plugin's
/// key code, and whether it means Shift too ("?" is Shift+/, as Electron reads it).
fn code_of(key: &str) -> Option<(Code, bool)> {
    use Code::*;
    let k = key.to_ascii_lowercase();
    let letters = [KeyA, KeyB, KeyC, KeyD, KeyE, KeyF, KeyG, KeyH, KeyI, KeyJ, KeyK, KeyL, KeyM, KeyN, KeyO, KeyP, KeyQ, KeyR, KeyS, KeyT, KeyU, KeyV, KeyW, KeyX, KeyY, KeyZ];
    let digits = [Digit0, Digit1, Digit2, Digit3, Digit4, Digit5, Digit6, Digit7, Digit8, Digit9];
    let numpad = [Numpad0, Numpad1, Numpad2, Numpad3, Numpad4, Numpad5, Numpad6, Numpad7, Numpad8, Numpad9];
    let fkeys = [F1, F2, F3, F4, F5, F6, F7, F8, F9, F10, F11, F12, F13, F14, F15, F16, F17, F18, F19, F20, F21, F22, F23, F24];
    let mut chars = k.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        if c.is_ascii_lowercase() {
            return Some((letters[(c as u8 - b'a') as usize], false));
        }
        if c.is_ascii_digit() {
            return Some((digits[(c as u8 - b'0') as usize], false));
        }
        // punctuation, and what it is with Shift on a US keyboard (Electron's reading)
        return Some(match c {
            '`' => (Backquote, false),
            '~' => (Backquote, true),
            '-' => (Minus, false),
            '_' => (Minus, true),
            '=' => (Equal, false),
            '+' => (Equal, true),
            '[' => (BracketLeft, false),
            '{' => (BracketLeft, true),
            ']' => (BracketRight, false),
            '}' => (BracketRight, true),
            '\\' => (Backslash, false),
            '|' => (Backslash, true),
            ';' => (Semicolon, false),
            ':' => (Semicolon, true),
            '\'' => (Quote, false),
            '"' => (Quote, true),
            ',' => (Comma, false),
            '<' => (Comma, true),
            '.' => (Period, false),
            '>' => (Period, true),
            '/' => (Slash, false),
            '?' => (Slash, true),
            '!' => (Digit1, true),
            '@' => (Digit2, true),
            '#' => (Digit3, true),
            '$' => (Digit4, true),
            '%' => (Digit5, true),
            '^' => (Digit6, true),
            '&' => (Digit7, true),
            '*' => (Digit8, true),
            '(' => (Digit9, true),
            ')' => (Digit0, true),
            _ => return None,
        });
    }
    if let Some(n) = k.strip_prefix('f').and_then(|n| n.parse::<usize>().ok()) {
        return fkeys.get(n.checked_sub(1)?).map(|&c| (c, false));
    }
    if let Some(n) = k.strip_prefix("num").and_then(|n| n.parse::<usize>().ok()) {
        return numpad.get(n).map(|&c| (c, false));
    }
    Some((
        match k.as_str() {
            // (Electron's "Plus" is the =/+ key)
            "plus" => Equal,
            "space" => Space,
            "tab" => Tab,
            "capslock" => CapsLock,
            "numlock" => NumLock,
            "scrolllock" => ScrollLock,
            "backspace" => Backspace,
            "delete" | "del" => Delete,
            "insert" | "ins" => Insert,
            "return" | "enter" => Enter,
            "up" | "arrowup" => ArrowUp,
            "down" | "arrowdown" => ArrowDown,
            "left" | "arrowleft" => ArrowLeft,
            "right" | "arrowright" => ArrowRight,
            "home" => Home,
            "end" => End,
            "pageup" => PageUp,
            "pagedown" => PageDown,
            "escape" | "esc" => Escape,
            "pause" => Pause,
            "printscreen" => PrintScreen,
            "volumeup" => AudioVolumeUp,
            "volumedown" => AudioVolumeDown,
            "volumemute" => AudioVolumeMute,
            "medianexttrack" => MediaTrackNext,
            "mediaprevioustrack" => MediaTrackPrevious,
            "mediastop" => MediaStop,
            "mediaplaypause" => MediaPlayPause,
            "numdec" => NumpadDecimal,
            "numadd" => NumpadAdd,
            "numsub" => NumpadSubtract,
            "nummult" => NumpadMultiply,
            "numdiv" => NumpadDivide,
            _ => return None,
        },
        false,
    ))
}

/// An Electron accelerator ("Ctrl+Alt+W", "CommandOrControl+Shift+Space", "Alt+Plus") as
/// a shortcut the plugin binds. None if it isn't one (no key, two keys, a name it can't read).
pub fn parse_accelerator(accel: &str) -> Option<Shortcut> {
    let mut mods = Modifiers::empty();
    let mut code = None;
    let accel = accel.trim();
    // "+" is a key of its own at the end ("Ctrl++"); everything else is split on it
    let (head, tail_plus) = match accel.strip_suffix("++") {
        Some(h) => (h, true),
        None => (accel, accel == "+"),
    };
    let mut parts: Vec<&str> = if head.is_empty() || head == "+" { vec![] } else { head.split('+').map(str::trim).collect() };
    if tail_plus {
        parts.push("+");
    }
    for part in parts {
        match part.to_ascii_lowercase().as_str() {
            "" => return None,
            "ctrl" | "control" | "commandorcontrol" | "cmdorctrl" | "cmdorcontrol" | "commandorctrl" => mods |= Modifiers::CONTROL,
            "alt" | "option" | "altgr" => mods |= Modifiers::ALT,
            "shift" => mods |= Modifiers::SHIFT,
            "super" | "meta" | "cmd" | "command" | "win" => mods |= Modifiers::SUPER,
            _ => {
                if code.is_some() {
                    return None;
                }
                let (c, shifted) = code_of(part)?;
                if shifted {
                    mods |= Modifiers::SHIFT;
                }
                code = Some(c);
            }
        }
    }
    Some(Shortcut::new(Some(mods), code?))
}

/// The virtual-key code of an accelerator's main key ('W' in Ctrl+Alt+W), so
/// read_selection waits for it to come up too (capture.js keyCode).
fn key_code(accel: &str) -> Option<i32> {
    let last = accel.rsplit('+').next()?.trim();
    if last.eq_ignore_ascii_case("space") {
        return Some(0x20);
    }
    if let Some(n) = last.strip_prefix(['F', 'f']).and_then(|n| n.parse::<i32>().ok()).filter(|n| (1..=24).contains(n)) {
        return Some(0x70 + n - 1); // VK_F1…
    }
    match last.as_bytes() {
        [c] if c.is_ascii_alphanumeric() => Some(c.to_ascii_uppercase() as i32),
        _ => None,
    }
}

/// Bind a global hotkey ("Ctrl+Alt+W"…) under a name (its setting); binding the same name
/// again replaces it. Says whether it worked (false: another app has those keys).
pub fn register(app: &AppHandle, name: &str, keys: &str, run: fn(&AppHandle)) -> bool {
    unregister(app, name);
    if keys.trim().is_empty() {
        return false;
    }
    let Some(shortcut) = parse_accelerator(keys) else {
        eprintln!("[capture] bad hotkey {keys}");
        return false;
    };
    // (the handler runs on the main thread: what it does — waiting for keys, opening
    // windows, reading the clipboard — goes on a thread of its own)
    let res = app.global_shortcut().on_shortcut(shortcut, move |app, _, event| {
        if event.state == ShortcutState::Pressed {
            let app = app.clone();
            thread::spawn(move || run(&app));
        }
    });
    match res {
        Ok(()) => {
            bound().lock().unwrap_or_else(|e| e.into_inner()).insert(name.to_string(), shortcut);
            true
        }
        Err(err) => {
            eprintln!("[capture] {keys} is taken by another app ({err})");
            false
        }
    }
}

/// Unbind a hotkey bound under this name (if it is).
pub fn unregister(app: &AppHandle, name: &str) {
    let old = bound().lock().unwrap_or_else(|e| e.into_inner()).remove(name);
    if let Some(shortcut) = old {
        let _ = app.global_shortcut().unregister(shortcut);
    }
}

// ---------------------------------------------------------------- the selection

// one grab or paste at a time (each borrows the clipboard)
static BUSY: AtomicBool = AtomicBool::new(false);
// apps copy a selection within a few tens of ms: if the clipboard hasn't changed at all
// after this many 15 ms looks, nothing's selected
const QUIET_TICKS: usize = 10;

/// Holds BUSY and the clipboard as it was; both are put back when it's dropped, whatever
/// happens in between.
struct Borrowed(Option<clip::Saved>);

impl Borrowed {
    fn take() -> Option<Borrowed> {
        if BUSY.swap(true, Ordering::SeqCst) {
            return None;
        }
        Some(Borrowed(Some(clip::save())))
    }
}

impl Drop for Borrowed {
    fn drop(&mut self) {
        if let Some(saved) = self.0.take() {
            clip::restore(saved);
        }
        BUSY.store(false, Ordering::SeqCst);
    }
}

fn key_down(vk: i32) -> bool {
    // SAFETY: plain Win32 call; the high bit says the key is down now.
    (unsafe { GetAsyncKeyState(vk) } as u16 & 0x8000) != 0
}

/// Wait (a second at most) for the hotkey's keys to come up, so our Ctrl+C isn't Ctrl+Alt+C.
fn keys_released(extra: Option<i32>) {
    let mut keys = vec![VK_SHIFT as i32, VK_CONTROL as i32, VK_MENU as i32, VK_LWIN as i32, VK_RWIN as i32];
    keys.extend(extra);
    for _ in 0..70 {
        if !keys.iter().any(|&k| key_down(k)) {
            return;
        }
        thread::sleep(Duration::from_millis(15));
    }
}

fn key_input(vk: u16, up: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: vk, wScan: 0, dwFlags: if up { KEYEVENTF_KEYUP } else { 0 }, time: 0, dwExtraInfo: 0 } },
    }
}

/// Ctrl + a key, pressed and let go, into whatever window has the keyboard.
fn press_ctrl(vk: u16) {
    let inputs = [key_input(VK_CONTROL, false), key_input(vk, false), key_input(vk, true), key_input(VK_CONTROL, true)];
    // SAFETY: a valid array of keyboard INPUTs, its length and the struct's size.
    unsafe { SendInput(inputs.len() as u32, inputs.as_ptr(), std::mem::size_of::<INPUT>() as i32) };
}

/// What was copied, tidied: keep_lines keeps its line breaks (no spaces left at line ends);
/// else it's all on one line (a word, a phrase).
pub fn tidy(text: &str, keep_lines: bool) -> String {
    if keep_lines {
        let unix = text.replace("\r\n", "\n").replace('\r', "\n");
        unix.split('\n').map(|l| l.trim_end_matches([' ', '\t'])).collect::<Vec<_>>().join("\n").trim().to_string()
    } else {
        text.split_whitespace().collect::<Vec<_>>().join(" ")
    }
}

fn foreground() -> isize {
    // SAFETY: plain Win32 call.
    unsafe { GetForegroundWindow() as isize }
}

/// What's selected in the app in front (hotkey_keys: the hotkey that's still held down, so
/// the simulated Ctrl+C isn't mixed up with it; keep_lines: keep the line breaks).
pub fn read_selection(_app: &AppHandle, hotkey_keys: &str, keep_lines: bool) -> Selection {
    let source = foreground_title();
    let hwnd = foreground();
    let Some(_borrowed) = Borrowed::take() else { return Selection { text: String::new(), source, hwnd } };
    keys_released(key_code(hotkey_keys));
    clip::clear();
    let before = clip::sequence();
    press_ctrl(VK_C);
    let mut text = String::new();
    for i in 0..40 {
        thread::sleep(Duration::from_millis(15));
        if i >= QUIET_TICKS && clip::sequence() == before {
            break;
        }
        text = clip::text();
        if !text.is_empty() {
            break;
        }
    }
    Selection { text: tidy(&text, keep_lines), source, hwnd }
    // (the clipboard goes back as it was as _borrowed drops)
}

/// Paste text over the selection in that window (Quick actions' Replace). False if it's gone.
pub fn paste_into(hwnd: isize, text: &str) -> bool {
    // SAFETY: IsWindow takes any value and says whether it's a window.
    if hwnd == 0 || unsafe { IsWindow(hwnd as HWND) } == 0 {
        return false;
    }
    let Some(_borrowed) = Borrowed::take() else { return false };
    if !clip::set_text(text) {
        return false;
    }
    // SAFETY: a window that exists (checked above); fails harmlessly if it's gone since.
    unsafe { SetForegroundWindow(hwnd as HWND) };
    thread::sleep(Duration::from_millis(160)); // (its caret and selection come back)
    keys_released(None);
    press_ctrl(VK_V);
    thread::sleep(Duration::from_millis(350)); // (the app reads the clipboard before it's put back)
    true
}

/// The title of the window in front ("" if it's one of ours).
pub fn foreground_title() -> String {
    let hwnd = foreground();
    if hwnd == 0 {
        return String::new();
    }
    let mut pid = 0u32;
    // SAFETY: a window handle (possibly stale: then it fails) and somewhere to put the id.
    unsafe { GetWindowThreadProcessId(hwnd as HWND, &mut pid) };
    if pid == std::process::id() {
        return String::new();
    }
    let mut buf = [0u16; 512];
    // SAFETY: the buffer and its length in UTF-16 units.
    let n = unsafe { GetWindowTextW(hwnd as HWND, buf.as_mut_ptr(), buf.len() as i32) };
    String::from_utf16_lossy(&buf[..n.clamp(0, buf.len() as i32) as usize])
}

// ---------------------------------------------------------------- presenting

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

/// Windows would show a notification now (not in quiet hours / focus assist):
/// QUNS_ACCEPTS_NOTIFICATIONS, or it can't tell.
pub fn accepts_notifications() -> bool {
    matches!(notification_state(), 0 | 5)
}

pub fn setup(_app: &AppHandle) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn sc(mods: Modifiers, code: Code) -> Option<Shortcut> {
        Some(Shortcut::new(Some(mods), code))
    }

    #[test]
    fn accelerators() {
        let ca = Modifiers::CONTROL | Modifiers::ALT;
        assert_eq!(parse_accelerator("Ctrl+Alt+W"), sc(ca, Code::KeyW));
        assert_eq!(parse_accelerator("ctrl+alt+b"), sc(ca, Code::KeyB));
        assert_eq!(parse_accelerator("CommandOrControl+Shift+Space"), sc(Modifiers::CONTROL | Modifiers::SHIFT, Code::Space));
        assert_eq!(parse_accelerator("Alt+Plus"), sc(Modifiers::ALT, Code::Equal));
        assert_eq!(parse_accelerator("Ctrl++"), sc(Modifiers::CONTROL | Modifiers::SHIFT, Code::Equal));
        assert_eq!(parse_accelerator("Ctrl+Alt+?"), sc(ca | Modifiers::SHIFT, Code::Slash));
        assert_eq!(parse_accelerator("Ctrl+Alt+1"), sc(ca, Code::Digit1));
        assert_eq!(parse_accelerator("Ctrl+F12"), sc(Modifiers::CONTROL, Code::F12));
        assert_eq!(parse_accelerator("Ctrl+Alt+Up"), sc(ca, Code::ArrowUp));
        assert_eq!(parse_accelerator("Ctrl+Alt+num5"), sc(ca, Code::Numpad5));
        assert_eq!(parse_accelerator("Ctrl+Alt+PageDown"), sc(ca, Code::PageDown));
        assert_eq!(parse_accelerator("Super+Shift+S"), sc(Modifiers::SUPER | Modifiers::SHIFT, Code::KeyS));
        assert_eq!(parse_accelerator("Ctrl+Alt+,"), sc(ca, Code::Comma));
        assert_eq!(parse_accelerator("F9"), sc(Modifiers::empty(), Code::F9));
        // not hotkeys
        assert_eq!(parse_accelerator(""), None);
        assert_eq!(parse_accelerator("Ctrl+Alt"), None);
        assert_eq!(parse_accelerator("Ctrl+A+B"), None);
        assert_eq!(parse_accelerator("Ctrl+Alt+Banana"), None);
        assert_eq!(parse_accelerator("Ctrl+F25"), None);
        assert_eq!(parse_accelerator("Ctrl++Alt"), None);
    }

    #[test]
    fn main_key_codes() {
        assert_eq!(key_code("Ctrl+Alt+W"), Some(0x57));
        assert_eq!(key_code("Ctrl+Alt+w"), Some(0x57));
        assert_eq!(key_code("Ctrl+Alt+3"), Some(0x33));
        assert_eq!(key_code("Ctrl+Space"), Some(0x20));
        assert_eq!(key_code("Ctrl+F2"), Some(0x71));
        assert_eq!(key_code("Ctrl+Alt+Up"), None);
        assert_eq!(key_code(""), None);
    }

    #[test]
    fn tidying() {
        assert_eq!(tidy("  hello \r\n  world\t", false), "hello world");
        assert_eq!(tidy("\r\nline one  \r\n\tline two\t\rthree\n\n", true), "line one\n\tline two\nthree");
        assert_eq!(tidy("", true), "");
    }
}
