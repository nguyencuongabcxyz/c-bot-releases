//! cbot-file:// : the chat's pictures and files, served from the folders it may show (paths::picture_roots), never from anywhere else.

use super::*;

pub(super) const MAX_PICTURE: u64 = 30 * 1024 * 1024;

pub(super) fn image_type(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        _ => return None,
    })
}

pub(super) fn query_param(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        (k == key).then(|| percent_decode(v))
    })
}

/// "C%3A%5Cx" -> "C:\x" (as encodeURIComponent wrote it)
pub(super) fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = bytes
            .get(i + 1..i + 3)
            .and_then(|h| std::str::from_utf8(h).ok())
            .and_then(|h| u8::from_str_radix(h, 16).ok());
        match (bytes[i], hex) {
            (b'%', Some(b)) => {
                out.push(b);
                i += 3;
            }
            (b'+', _) => {
                out.push(b' ');
                i += 1;
            }
            (b, _) => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// PDFs, songs and videos the chat's file viewer shows through cbot-file://view/.
pub(super) fn media_type(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "pdf" => "application/pdf",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" | "oga" | "opus" => "audio/ogg",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "flac" => "audio/flac",
        "weba" => "audio/webm",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "ogv" => "video/ogg",
        "mov" => "video/quicktime",
        _ => return None,
    })
}

/// A file (not the folder itself) inside one of the folders it may show files from.
pub(super) fn may_serve(p: &str, allowed: &[String]) -> bool {
    Path::new(p).is_absolute()
        && allowed
            .iter()
            .any(|root| !root.is_empty() && is_inside(p, root) && !is_inside(root, p))
}

pub(super) fn not_found() -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(404)
        .body(b"Not found".to_vec())
        .expect("fixed headers")
}

/// cbot-file: a picture (img/?path=…), or a PDF, song or video (view/?path=…).
pub fn serve(
    request: &tauri::http::Request<Vec<u8>>,
    allowed: &[String],
) -> tauri::http::Response<Vec<u8>> {
    if request.uri().path().starts_with("/view") {
        let range = request
            .headers()
            .get(tauri::http::header::RANGE)
            .and_then(|v| v.to_str().ok());
        serve_view(request.uri(), range, allowed)
    } else {
        serve_image(request.uri(), allowed)
    }
}

/// cbot-file://img/?path=… : a picture from one of the folders it may show pictures from.
pub(super) fn serve_image(
    uri: &tauri::http::Uri,
    allowed: &[String],
) -> tauri::http::Response<Vec<u8>> {
    let p = query_param(uri.query().unwrap_or(""), "path").unwrap_or_default();
    let Some(ty) = image_type(&ext_of(&p)) else {
        return not_found();
    };
    if !may_serve(&p, allowed) {
        return not_found();
    }
    let Ok(meta) = std::fs::metadata(&p) else {
        return not_found();
    };
    if !meta.is_file() || meta.len() > MAX_PICTURE {
        return not_found();
    }
    let Ok(bytes) = std::fs::read(&p) else {
        return not_found();
    };
    let mut res = tauri::http::Response::builder()
        .header("Content-Type", ty)
        .header("Cache-Control", "max-age=10") // answers re-render while they stream; previews of edited files add ?v=
        .header("Access-Control-Allow-Origin", "*");
    if ty == "image/svg+xml" {
        res = res.header(
            "Content-Security-Policy",
            "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:",
        );
    }
    res.body(bytes).expect("fixed headers")
}

pub(super) const MEDIA_CHUNK: u64 = 4 * 1024 * 1024;
pub(super) const MEDIA_WHOLE: u64 = 200 * 1024 * 1024;

/// "bytes=10-", "bytes=10-99", "bytes=-500" -> the first and last byte asked for, of `len`.
pub(super) fn byte_range(header: &str, len: u64) -> Option<(u64, u64)> {
    let spec = header
        .trim()
        .strip_prefix("bytes=")?
        .split(',')
        .next()?
        .trim();
    let (a, b) = spec.split_once('-')?;
    let last = len.checked_sub(1)?;
    let (start, end) = match (a.trim(), b.trim()) {
        ("", n) => (len.saturating_sub(n.parse().ok()?), last),
        (s, "") => (s.parse().ok()?, last),
        (s, e) => (s.parse().ok()?, e.parse::<u64>().ok()?.min(last)),
    };
    (start <= end).then_some((start, end))
}

/// cbot-file://view/?path=… : a PDF, song or video for the file viewer, a piece at a time
/// when the player asks for one (so a long video can be skipped through).
pub(super) fn serve_view(
    uri: &tauri::http::Uri,
    range: Option<&str>,
    allowed: &[String],
) -> tauri::http::Response<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    let p = query_param(uri.query().unwrap_or(""), "path").unwrap_or_default();
    let Some(ty) = media_type(&ext_of(&p)) else {
        return not_found();
    };
    if !may_serve(&p, allowed) {
        return not_found();
    }
    let Ok(meta) = std::fs::metadata(&p) else {
        return not_found();
    };
    if !meta.is_file() {
        return not_found();
    }
    let len = meta.len();
    let res = || {
        tauri::http::Response::builder()
            .header("Content-Type", ty)
            .header("Accept-Ranges", "bytes")
            .header("Cache-Control", "no-cache")
            .header("Access-Control-Allow-Origin", "*")
    };
    let Some(range) = range else {
        if len > MEDIA_WHOLE {
            return tauri::http::Response::builder()
                .status(413)
                .body(Vec::new())
                .expect("fixed headers");
        }
        let Ok(bytes) = std::fs::read(&p) else {
            return not_found();
        };
        return res().body(bytes).expect("fixed headers");
    };
    let Some((start, end)) = byte_range(range, len) else {
        return res()
            .status(416)
            .header("Content-Range", format!("bytes */{len}"))
            .body(Vec::new())
            .expect("fixed headers");
    };
    let end = end.min(start + MEDIA_CHUNK - 1);
    let mut piece = vec![0; (end - start + 1) as usize];
    let read = std::fs::File::open(&p).and_then(|mut f| {
        f.seek(SeekFrom::Start(start))?;
        f.read_exact(&mut piece)
    });
    if read.is_err() {
        return not_found();
    }
    res()
        .status(206)
        .header("Content-Range", format!("bytes {start}-{end}/{len}"))
        .body(piece)
        .expect("fixed headers")
}
