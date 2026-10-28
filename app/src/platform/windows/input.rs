//! The keyboard and mouse through Win32: a Key's virtual-key code, whether it's down, pressing
//! keys (SendInput), and Windows' last-input stamp. (What's built on these: platform/input.rs.)

use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, GetLastInputInfo, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT,
    KEYEVENTF_KEYUP, LASTINPUTINFO, SendInput, VK_CONTROL, VK_F1, VK_LBUTTON, VK_LWIN, VK_MENU,
    VK_RBUTTON, VK_RWIN, VK_SHIFT, VK_SPACE,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_SWAPBUTTON};

use crate::platform::common::types::Key;

/// Its virtual-key code (Meta: the left Win key).
fn vk(key: Key) -> u16 {
    match key {
        Key::Ctrl => VK_CONTROL,
        Key::Shift => VK_SHIFT,
        Key::Alt => VK_MENU,
        Key::Meta => VK_LWIN,
        Key::Space => VK_SPACE,
        Key::Char(c) => c.to_ascii_uppercase() as u16, // ('A'–'Z', '0'–'9' are their own codes)
        Key::F(n) => VK_F1 + u16::from(n.clamp(1, 24)) - 1,
    }
}

fn vk_down(vk: u16) -> bool {
    // SAFETY: plain Win32 call; the high bit says the key is down now.
    (unsafe { GetAsyncKeyState(i32::from(vk)) } as u16 & 0x8000) != 0
}

pub fn is_down(key: Key) -> bool {
    match key {
        Key::Meta => vk_down(VK_LWIN) || vk_down(VK_RWIN),
        k => vk_down(vk(k)),
    }
}

/// The main mouse button is down (the physical one: GetAsyncKeyState ignores swapping).
pub fn main_button_down() -> bool {
    // SAFETY: plain Win32 call.
    let swapped = unsafe { GetSystemMetrics(SM_SWAPBUTTON) } != 0;
    vk_down(if swapped { VK_RBUTTON } else { VK_LBUTTON })
}

fn input(vk: u16, up: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: 0,
                dwFlags: if up { KEYEVENTF_KEYUP } else { 0 },
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

/// Press `keys` in order and let them go the other way round ([Ctrl, Char('V')]: Ctrl+V),
/// into whatever window has the keyboard; whether Windows took them all.
pub fn press(keys: &[Key]) -> bool {
    let codes: Vec<u16> = keys.iter().map(|&k| vk(k)).collect();
    let inputs: Vec<INPUT> = codes
        .iter()
        .map(|&c| input(c, false))
        .chain(codes.iter().rev().map(|&c| input(c, true)))
        .collect();
    // SAFETY: a valid array of keyboard INPUTs, its length and the struct's size.
    let sent = unsafe {
        SendInput(
            inputs.len() as u32,
            inputs.as_ptr(),
            std::mem::size_of::<INPUT>() as i32,
        )
    };
    sent as usize == inputs.len()
}

/// Windows' last-input stamp: it changes whenever you touch the mouse or keyboard.
pub fn last_input_stamp() -> u64 {
    let mut info = LASTINPUTINFO {
        cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };
    // SAFETY: fills in the struct we pass (its size set as asked).
    unsafe { GetLastInputInfo(&mut info) };
    u64::from(info.dwTime)
}
