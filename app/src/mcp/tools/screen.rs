//! Looking at the screen (screenshot): the screen with the mouse on it (or all of them) is
//! captured as it is now, the robots cloaked for a moment so they're not in the way. The full
//! picture is saved with the pasted screenshots, and a smaller copy goes back to Claude to
//! look at (server.rs passes it on as image content).

use std::io::Cursor;
use std::thread;
use std::time::Duration;

use base64::Engine;
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::{DynamicImage, ImageFormat, RgbaImage};
use serde::Deserialize;
use serde_json::{Value, json};
use tauri::AppHandle;

use super::err;
use crate::platform::{presence, screenshot, window};
use crate::robots;
use crate::runtime::util::text;
use crate::runtime::with;
use crate::workbench::{capture, files};

// the longest side Claude looks at (a bigger picture is scaled down anyway)
const LOOK_MAX: u32 = 1568;
const JPEG_QUALITY: u8 = 85;

/// Which screen to capture (its "screen" argument).
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Which {
    /// The one the mouse is on.
    #[default]
    Mouse,
    /// All of them together.
    All,
}

impl Which {
    /// From the call's arguments (left out, or one we don't know: the mouse's).
    fn of(args: &Value) -> Self {
        serde_json::from_value(args["screen"].clone()).unwrap_or_default()
    }

    fn area(self) -> window::Rect {
        match self {
            Which::Mouse => {
                let (x, y) = window::cursor();
                window::monitor_near(x, y).bounds
            }
            Which::All => window::all_screens(),
        }
    }

    fn said(self) -> &'static str {
        match self {
            Which::Mouse => "The screen with the mouse on it",
            Which::All => "All the screens",
        }
    }
}

/// Its tool, as tools/list gives it.
pub fn list() -> Value {
    json!([
        {
            "name": "screenshot",
            "description": concat!(
                "Take a screenshot of the user's screen as it is now and look at it. The C-Bot robots are left out of the picture. ",
                "Use it when the user asks what's on their screen, or to look at, check, read or help with something they're looking at (an error dialog, a web page, an app, a chart), instead of asking them to describe it or paste a picture. ",
                "Returns the picture (scaled to fit) and the path of the full-size PNG, to Read for a closer look at small text."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "screen": { "type": "string", "enum": ["mouse", "all"], "description": "Which screen: the one the mouse is on (default) or all of them together." },
                    "show_robots": { "type": "boolean", "description": "Keep the C-Bot robots in the picture (when the user asks about C-Bot itself)." },
                },
                "additionalProperties": false,
            },
            "annotations": super::at_once(),
        },
    ])
}

/// The size it's shown to Claude at: fits in LOOK_MAX, never made bigger.
fn look_size(w: u32, h: u32) -> (u32, u32) {
    let long = w.max(h);
    if long <= LOOK_MAX {
        return (w, h);
    }
    let k = LOOK_MAX as f64 / long as f64;
    (
        ((w as f64 * k).round() as u32).max(1),
        ((h as f64 * k).round() as u32).max(1),
    )
}

/// The smaller copy for Claude, as a JPEG.
fn look_jpeg(image: &RgbaImage) -> Option<Vec<u8>> {
    let (w, h) = look_size(image.width(), image.height());
    let small = if (w, h) == image.dimensions() {
        image.clone()
    } else {
        image::imageops::resize(image, w, h, FilterType::Triangle)
    };
    let mut out = Vec::new();
    DynamicImage::ImageRgba8(small)
        .to_rgb8()
        .write_with_encoder(JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY))
        .ok()?;
    Some(out)
}

fn png_bytes(image: &RgbaImage) -> Option<Vec<u8>> {
    let mut out = Cursor::new(Vec::new());
    image.write_to(&mut out, ImageFormat::Png).ok()?;
    Some(out.into_inner())
}

/// That part of the screen as it is now, the robots out of the way (not hidden: nothing
/// moves, and they're back in a moment) unless they're wanted in it.
fn shoot(app: &AppHandle, area: window::Rect, show_robots: bool) -> Option<RgbaImage> {
    let hidden: Vec<isize> = if show_robots {
        vec![]
    } else {
        robots::open_ids(app)
            .iter()
            .filter_map(|id| robots::hwnd_of(app, id))
            .filter(|&h| window::is_visible(h))
            .collect()
    };
    for &h in &hidden {
        screenshot::cloak(h, true);
    }
    if !hidden.is_empty() {
        thread::sleep(Duration::from_millis(120)); // (till the screen's redrawn without them)
    }
    let image = screenshot::capture(area);
    for &h in &hidden {
        screenshot::cloak(h, false);
    }
    image
}

/// The screenshot tool: { screen: "mouse" | "all", show_robots } -> { text, image, isError }.
pub fn call(app: &AppHandle, args: &Value) -> Value {
    if presence::locked() {
        return err("The screen is locked, so there's nothing to see.");
    }
    let which = Which::of(args);
    let in_front = capture::foreground_title();
    let Some(image) = shoot(app, which.area(), args["show_robots"] == true) else {
        return err("Couldn't capture the screen.");
    };
    let Some(look) = look_jpeg(&image) else {
        return err("Couldn't encode the screenshot.");
    };
    let dir = with(app, |st| st.data_dir.join("attachments"));
    let saved = png_bytes(&image)
        .and_then(|png| files::save_paste(&dir, &png, "png"))
        .map(|f| text(&f["path"]));
    json!({
        "text": describe(which.said(), image.dimensions(), &in_front, saved.as_deref()),
        "image": { "data": base64::engine::general_purpose::STANDARD.encode(look), "mimeType": "image/jpeg" },
    })
}

/// What Claude reads with the picture.
fn describe(what: &str, (w, h): (u32, u32), in_front: &str, saved: Option<&str>) -> String {
    let (lw, lh) = look_size(w, h);
    let shown = if (lw, lh) != (w, h) {
        format!(", shown here at {lw}×{lh}")
    } else {
        String::new()
    };
    let mut lines = vec![format!("{what} ({w}×{h} px{shown}).")];
    if !in_front.is_empty() {
        lines.push(format!("In front: {in_front}"));
    }
    if let Some(path) = saved {
        lines.push(format!(
            "Full size saved at {path} (Read it to look closer at small text)."
        ));
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn which_screen_is_read_from_its_argument() {
        assert_eq!(Which::of(&json!({ "screen": "all" })), Which::All);
        assert_eq!(Which::of(&json!({ "screen": "mouse" })), Which::Mouse);
        assert_eq!(Which::of(&json!({})), Which::Mouse);
        assert_eq!(Which::of(&json!({ "screen": "left" })), Which::Mouse);
    }

    #[test]
    fn it_is_shown_no_bigger_than_claude_looks() {
        assert_eq!(look_size(1280, 720), (1280, 720));
        assert_eq!(look_size(1568, 900), (1568, 900));
        assert_eq!(look_size(2560, 1440), (1568, 882));
        assert_eq!(look_size(1440, 2560), (882, 1568));
        assert_eq!(look_size(5120, 1440), (1568, 441));
    }

    #[test]
    fn the_copy_for_claude_is_a_smaller_jpeg() {
        let img = RgbaImage::from_pixel(3136, 100, image::Rgba([10, 200, 30, 255]));
        let jpeg = look_jpeg(&img).unwrap();
        let back = image::load_from_memory_with_format(&jpeg, ImageFormat::Jpeg).unwrap();
        assert_eq!((back.width(), back.height()), (1568, 50));
    }

    #[test]
    fn it_says_what_was_captured_and_where_it_is() {
        assert_eq!(
            describe(
                "All the screens",
                (2560, 1440),
                "Teams",
                Some("C:\\a\\Screenshot.png")
            ),
            "All the screens (2560×1440 px, shown here at 1568×882).\nIn front: Teams\nFull size saved at C:\\a\\Screenshot.png (Read it to look closer at small text)."
        );
        assert_eq!(
            describe("The screen with the mouse on it", (1280, 720), "", None),
            "The screen with the mouse on it (1280×720 px)."
        );
    }
}
