//! Pictures as the systems hand them over, made ready for the chat (the same everywhere).

use std::io::Cursor;

use image::{DynamicImage, ImageFormat};

/// A picture whose alpha is all zero (the way many apps fill it) is meant to be seen.
pub fn opaque_if_blank(img: DynamicImage) -> DynamicImage {
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
