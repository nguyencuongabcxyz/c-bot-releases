//! Things fed to a robot from the clipboard and by dragging files onto it (main.js
//! clipboardEntries, inspectPath's thumbnails): a copied picture or screenshot (saved like a
//! pasted one), a file copied in Explorer, and the small previews on the file chips.
//! [wave 1: input]

use std::io::Cursor;
use std::path::Path;

use base64::Engine;
use image::imageops::FilterType;
use image::{ImageFormat, ImageReader};
use serde_json::{Value, json};
use tauri::AppHandle;

use crate::platform::clipboard;
use crate::runtime::with;
use crate::workbench::files;

// pictures bigger than this get no preview (main.js inspectPath)
const MAX_THUMB_SOURCE: u64 = 40 * 1024 * 1024;
// a file chip shows at most this many of what was copied
const MAX_FILES: usize = 20;

/// The preview's size: 96 px wide, or 64 px tall for a picture taller than it's wide
/// (what nativeImage.resize did with just one side given: the other follows).
pub fn thumb_size(w: u32, h: u32) -> (u32, u32) {
    let (w, h) = (w.max(1) as f64, h.max(1) as f64);
    let (tw, th) = if h > w {
        (w * 64.0 / h, 64.0)
    } else {
        (96.0, h * 96.0 / w)
    };
    ((tw.round() as u32).max(1), (th.round() as u32).max(1))
}

/// A small preview of a picture for a file chip (a data: URL), if it is one.
pub fn thumbnail(path: &str) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() >= MAX_THUMB_SOURCE {
        return None;
    }
    let img = ImageReader::open(path)
        .ok()?
        .with_guessed_format()
        .ok()?
        .decode()
        .ok()?;
    let (w, h) = thumb_size(img.width(), img.height());
    let small = img.resize_exact(w, h, FilterType::Triangle);
    let mut png = Cursor::new(Vec::new());
    small.write_to(&mut png, ImageFormat::Png).ok()?;
    Some(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(png.into_inner())
    ))
}

/// A file chip's entry (files::inspect) with its preview, when it's a picture
/// (main.js inspectPath with thumb).
pub fn with_thumb(mut entry: Value) -> Value {
    let picture = entry["isImage"].as_bool().unwrap_or(false);
    if let Some(thumb) = entry["path"]
        .as_str()
        .filter(|_| picture)
        .and_then(thumbnail)
    {
        entry["thumb"] = json!(thumb);
    }
    entry
}

/// A file or folder fed to the robot, with its preview (None if it isn't there).
pub fn inspect(path: &str) -> Option<Value> {
    files::inspect(path).map(with_thumb)
}

/// Is there something on the clipboard to paste into a robot (a picture or a file)?
pub fn has_something() -> bool {
    clipboard::has_image() || clipboard::has_files()
}

/// What's on the clipboard, as attachments: a copied picture or screenshot (saved like a
/// pasted one), or the files copied in Explorer.
fn entries(app: &AppHandle) -> Value {
    if let Some(png) = clipboard::image_png() {
        let dir = with(app, |st| st.data_dir.join("attachments"));
        return Value::Array(
            files::save_paste(&dir, &png, "png")
                .map(with_thumb)
                .into_iter()
                .collect(),
        );
    }
    Value::Array(
        clipboard::files()
            .iter()
            .filter(|p| Path::new(p).is_absolute())
            .take(MAX_FILES)
            .filter_map(|p| inspect(p))
            .collect(),
    )
}

/// A robot's "Paste screenshot / file from clipboard", or Ctrl+V with files copied in Explorer.
#[tauri::command(async)]
pub fn robot_paste_clipboard(app: AppHandle) -> Value {
    entries(&app)
}

pub fn setup(_app: &AppHandle) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thumb_sizes() {
        assert_eq!(thumb_size(1920, 1080), (96, 54));
        assert_eq!(thumb_size(1080, 1920), (36, 64));
        assert_eq!(thumb_size(500, 500), (96, 96)); // (square: by its width, as Electron)
        assert_eq!(thumb_size(10, 5), (96, 48)); // small ones grow
        assert_eq!(thumb_size(5000, 1), (96, 1));
        assert_eq!(thumb_size(0, 0), (96, 96));
    }

    #[test]
    fn thumbnail_of_a_picture() {
        let dir = std::env::temp_dir().join(format!("cbot-thumb-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("wide.png");
        image::RgbImage::from_pixel(300, 100, image::Rgb([200, 30, 30]))
            .save(&file)
            .unwrap();
        let url = thumbnail(&file.to_string_lossy()).expect("a preview");
        assert!(url.starts_with("data:image/png;base64,"));
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&url["data:image/png;base64,".len()..])
            .unwrap();
        let small = image::load_from_memory(&bytes).unwrap();
        assert_eq!((small.width(), small.height()), (96, 32));
        // not a picture, or not there
        let text = dir.join("notes.txt");
        std::fs::write(&text, "hello").unwrap();
        assert_eq!(thumbnail(&text.to_string_lossy()), None);
        assert_eq!(thumbnail(&dir.join("gone.png").to_string_lossy()), None);
        let entry = with_thumb(files::inspect(&file.to_string_lossy()).unwrap());
        assert!(entry["thumb"].as_str().is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
