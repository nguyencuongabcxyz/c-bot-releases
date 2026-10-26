//! The Windows clipboard, straight through Win32 (what Electron's `clipboard` gave main):
//! its text, a copied picture, files copied in Explorer, and saving what's on it to put it
//! back after a simulated Ctrl+C / Ctrl+V (capture.rs).

use std::io::Cursor;
use std::thread;
use std::time::Duration;

use image::codecs::bmp::BmpDecoder;
use image::{DynamicImage, ImageFormat};
use windows_sys::Win32::Foundation::{GlobalFree, HANDLE};
use windows_sys::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, GetClipboardSequenceNumber, IsClipboardFormatAvailable, OpenClipboard, RegisterClipboardFormatW,
    SetClipboardData,
};
use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE};
use windows_sys::Win32::System::Ole::{CF_DIB, CF_HDROP, CF_UNICODETEXT};

const CF_BITMAP: u32 = 2;
// (nothing on a clipboard is this big but a mistake; not worth copying to put back)
const MAX_FORMAT: usize = 256 * 1024 * 1024;

/// The clipboard, open on this thread until dropped. Another app may have it open for a
/// moment (the one answering our Ctrl+C, typically), so opening tries for a little while.
struct Open;

impl Open {
    fn new() -> Option<Open> {
        for _ in 0..25 {
            // SAFETY: plain Win32 call; no owner window (we never delay-render).
            if unsafe { OpenClipboard(std::ptr::null_mut()) } != 0 {
                return Some(Open);
            }
            thread::sleep(Duration::from_millis(10));
        }
        None
    }

    /// The bytes of one format, if it's there (an HGLOBAL format: text, DIB, HDROP…).
    fn get(&self, format: u32) -> Option<Vec<u8>> {
        // SAFETY: the clipboard is open (self); the handle stays valid until it's closed,
        // and is only read between GlobalLock and GlobalUnlock, within GlobalSize.
        unsafe {
            let h: HANDLE = GetClipboardData(format);
            if h.is_null() {
                return None;
            }
            let size = GlobalSize(h);
            if size == 0 || size > MAX_FORMAT {
                return None;
            }
            let p = GlobalLock(h) as *const u8;
            if p.is_null() {
                return None;
            }
            let bytes = std::slice::from_raw_parts(p, size).to_vec();
            GlobalUnlock(h);
            Some(bytes)
        }
    }

    /// Put bytes on as one format (after empty()). Windows owns the memory once it's taken.
    fn put(&self, format: u32, bytes: &[u8]) -> bool {
        // SAFETY: fresh movable memory of the right size, filled while locked; freed by us
        // only if the clipboard didn't take it.
        unsafe {
            let h = GlobalAlloc(GMEM_MOVEABLE, bytes.len().max(1));
            if h.is_null() {
                return false;
            }
            let p = GlobalLock(h) as *mut u8;
            if p.is_null() {
                GlobalFree(h);
                return false;
            }
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), p, bytes.len());
            GlobalUnlock(h);
            if SetClipboardData(format, h).is_null() {
                GlobalFree(h);
                return false;
            }
            true
        }
    }

    fn empty(&self) {
        // SAFETY: the clipboard is open (self).
        unsafe { EmptyClipboard() };
    }
}

impl Drop for Open {
    fn drop(&mut self) {
        // SAFETY: we opened it (Open::new).
        unsafe { CloseClipboard() };
    }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// UTF-16 up to its first nul, as text.
fn from_wide(units: &[u16]) -> String {
    let end = units.iter().position(|&u| u == 0).unwrap_or(units.len());
    String::from_utf16_lossy(&units[..end])
}

fn units_of(bytes: &[u8]) -> Vec<u16> {
    bytes.as_chunks::<2>().0.iter().map(|&c| u16::from_le_bytes(c)).collect()
}

/// A named format's number ("HTML Format", "PNG", "FileNameW"…).
pub fn format_id(name: &str) -> u32 {
    let w = wide(name);
    // SAFETY: a nul-terminated UTF-16 string that outlives the call.
    unsafe { RegisterClipboardFormatW(w.as_ptr()) }
}

/// Is that format on the clipboard? (doesn't open it)
pub fn has(format: u32) -> bool {
    // SAFETY: plain Win32 call.
    unsafe { IsClipboardFormatAvailable(format) != 0 }
}

/// Goes up every time anything is put on the clipboard.
pub fn sequence() -> u32 {
    // SAFETY: plain Win32 call.
    unsafe { GetClipboardSequenceNumber() }
}

/// The text on the clipboard ('' if none).
pub fn text() -> String {
    let Some(open) = Open::new() else { return String::new() };
    open.get(CF_UNICODETEXT as u32).map(|b| from_wide(&units_of(&b))).unwrap_or_default()
}

/// Put text on the clipboard (and nothing else).
pub fn set_text(text: &str) -> bool {
    let Some(open) = Open::new() else { return false };
    open.empty();
    let bytes: Vec<u8> = wide(text).iter().flat_map(|u| u.to_le_bytes()).collect();
    open.put(CF_UNICODETEXT as u32, &bytes)
}

pub fn clear() {
    if let Some(open) = Open::new() {
        open.empty();
    }
}

/// What was on the clipboard, to put back. Only the formats that matter to you (text,
/// formatted text, a picture, copied files): asking for everything would make some apps
/// (Office) render every format they offer, which can take a long while.
pub struct Saved(Vec<(u32, Vec<u8>)>);

fn kept_formats() -> Vec<u32> {
    let mut f = vec![CF_UNICODETEXT as u32, CF_DIB as u32, CF_HDROP as u32];
    for name in ["HTML Format", "Rich Text Format", "PNG", "Preferred DropEffect", "FileNameW", "FileName", "Shell IDList Array"] {
        match format_id(name) {
            0 => {}
            id => f.push(id),
        }
    }
    f
}

pub fn save() -> Saved {
    let Some(open) = Open::new() else { return Saved(vec![]) };
    Saved(kept_formats().into_iter().filter(|&f| has(f)).filter_map(|f| Some((f, open.get(f)?))).collect())
}

/// Put back what save() kept (an empty clipboard if it was empty).
pub fn restore(saved: Saved) {
    let Some(open) = Open::new() else { return };
    open.empty();
    for (format, bytes) in &saved.0 {
        open.put(*format, bytes);
    }
}

// ---------------------------------------------------------------- files

/// The paths in a CF_HDROP (a DROPFILES header, then nul-separated names ending in an
/// empty one; UTF-16 when fWide).
pub fn parse_hdrop(buf: &[u8]) -> Vec<String> {
    let u32_at = |i: usize| buf.get(i..i + 4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]));
    let (Some(offset), Some(wide)) = (u32_at(0), u32_at(16)) else { return vec![] };
    let Some(list) = buf.get(offset as usize..) else { return vec![] };
    let names: Vec<String> = if wide != 0 {
        units_of(list).split(|&u| u == 0).take_while(|s| !s.is_empty()).map(String::from_utf16_lossy).collect()
    } else {
        list.split(|&b| b == 0).take_while(|s| !s.is_empty()).map(|s| String::from_utf8_lossy(s).into_owned()).collect()
    };
    names
}

/// Files copied in Explorer (CF_HDROP; else the older single FileNameW).
pub fn files() -> Vec<String> {
    let Some(open) = Open::new() else { return vec![] };
    if let Some(drop) = open.get(CF_HDROP as u32) {
        let paths = parse_hdrop(&drop);
        if !paths.is_empty() {
            return paths;
        }
    }
    match format_id("FileNameW") {
        0 => vec![],
        id => open.get(id).map(|b| from_wide(&units_of(&b))).filter(|p| !p.is_empty()).into_iter().collect(),
    }
}

pub fn has_files() -> bool {
    has(CF_HDROP as u32) || matches!(format_id("FileNameW"), id if id != 0 && has(id))
}

// ---------------------------------------------------------------- pictures

pub fn has_image() -> bool {
    has(CF_DIB as u32) || has(CF_BITMAP) || matches!(format_id("PNG"), id if id != 0 && has(id))
}

/// A device-independent bitmap (CF_DIB: a BITMAPINFOHEADER and its pixels, no file
/// header) as a picture. Screenshots are 32-bit with nothing in the alpha byte: made opaque.
pub fn decode_dib(dib: &[u8]) -> Option<DynamicImage> {
    let decoder = BmpDecoder::new_without_file_header(Cursor::new(dib)).ok()?;
    let img = DynamicImage::from_decoder(decoder).ok()?;
    Some(opaque_if_blank(img))
}

/// A picture whose alpha is all zero (the way many apps fill it) is meant to be seen.
fn opaque_if_blank(img: DynamicImage) -> DynamicImage {
    match img {
        DynamicImage::ImageRgba8(mut rgba) if rgba.pixels().all(|p| p.0[3] == 0) => {
            rgba.pixels_mut().for_each(|p| p.0[3] = 255);
            DynamicImage::ImageRgba8(rgba)
        }
        other => other,
    }
}

pub fn png_bytes(img: &DynamicImage) -> Option<Vec<u8>> {
    let mut out = Cursor::new(Vec::new());
    img.write_to(&mut out, ImageFormat::Png).ok()?;
    Some(out.into_inner())
}

/// A copied picture or screenshot, as PNG: the "PNG" format as it is when an app put one
/// (it keeps transparency), else the bitmap.
pub fn image_png() -> Option<Vec<u8>> {
    let (png, dib) = {
        let open = Open::new()?;
        let png = match format_id("PNG") {
            0 => None,
            id => open.get(id),
        };
        let dib = if png.is_none() { open.get(CF_DIB as u32) } else { None };
        (png, dib)
    }; // (closed before the decoding: other apps wait while it's open)
    if let Some(png) = png.filter(|b| image::load_from_memory_with_format(b, ImageFormat::Png).is_ok()) {
        return Some(png);
    }
    png_bytes(&decode_dib(&dib?)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hdrop(names: &[&str], wide: bool) -> Vec<u8> {
        let mut buf = vec![];
        buf.extend(20u32.to_le_bytes()); // pFiles
        buf.extend([0u8; 8]); // pt
        buf.extend(0u32.to_le_bytes()); // fNC
        buf.extend((wide as u32).to_le_bytes()); // fWide
        for n in names {
            if wide {
                n.encode_utf16().chain([0]).for_each(|u| buf.extend(u.to_le_bytes()));
            } else {
                buf.extend(n.as_bytes());
                buf.push(0);
            }
        }
        buf.extend(if wide { vec![0u8, 0] } else { vec![0u8] });
        buf
    }

    #[test]
    fn hdrop_wide_and_narrow() {
        let names = ["C:\\Users\\me\\Pictures\\cat ü.png", "D:\\work\\report.docx"];
        assert_eq!(parse_hdrop(&hdrop(&names, true)), names);
        assert_eq!(parse_hdrop(&hdrop(&["C:\\a.txt"], false)), ["C:\\a.txt"]);
        assert!(parse_hdrop(&hdrop(&[], true)).is_empty());
        assert!(parse_hdrop(&[1, 2, 3]).is_empty());
        // an offset past the end
        let mut bad = hdrop(&names, true);
        bad[0] = 200;
        assert!(parse_hdrop(&bad).is_empty());
    }

    #[test]
    fn dib_screenshot_is_opaque() {
        // 2x1, 32-bit BI_RGB, bottom-up, alpha bytes 0 (as screenshots come)
        let mut dib = vec![];
        dib.extend(40u32.to_le_bytes());
        dib.extend(2i32.to_le_bytes());
        dib.extend(1i32.to_le_bytes());
        dib.extend(1u16.to_le_bytes());
        dib.extend(32u16.to_le_bytes());
        dib.extend(0u32.to_le_bytes()); // BI_RGB
        dib.extend([0u8; 20]);
        dib.extend([0, 0, 255, 0, 255, 0, 0, 0]); // red, blue (BGRA)
        let img = decode_dib(&dib).expect("decodes").to_rgba8();
        assert_eq!(img.get_pixel(0, 0).0, [255, 0, 0, 255]);
        assert_eq!(img.get_pixel(1, 0).0, [0, 0, 255, 255]);
        assert!(png_bytes(&DynamicImage::ImageRgba8(img)).is_some());
    }
}
