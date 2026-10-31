//! ONNX Runtime, which runs the sentence model (embed/): Microsoft's release for this system,
//! downloaded the first time it's needed into <dir>/runtime/<VERSION> (about 80 MB, of which
//! only its DLL is kept). The zip comes down as a .part, the DLL is taken out of it, and the
//! folder is complete once the DLL is there.

use super::*;

/// The release downloaded (and shown in the chat's details).
pub(in crate::context) const RUNTIME_VERSION: &str = "1.31.1";

/// The DLL, if it's been downloaded.
pub(in crate::context) fn runtime_downloaded(dir: &Path) -> Option<PathBuf> {
    let dll = dir
        .join("runtime")
        .join(RUNTIME_VERSION)
        .join("onnxruntime.dll");
    dll.exists().then_some(dll)
}

/// The DLL, downloaded if need be (`say` hears how far).
pub(in crate::context) fn runtime(
    dir: &Path,
    say: &(dyn Fn(&str) + Sync),
) -> Result<PathBuf, Error> {
    if let Some(dll) = runtime_downloaded(dir) {
        return Ok(dll);
    }
    if !cfg!(all(windows, target_arch = "x86_64")) {
        return Err("Search by meaning isn't available on this system yet.".into());
    }
    let at = dir.join("runtime").join(RUNTIME_VERSION);
    std::fs::create_dir_all(&at).map_err(|e| format!("Couldn't make {}: {e}", at.display()))?;
    let name = format!("onnxruntime-win-x64-{RUNTIME_VERSION}");
    let url = format!(
        "https://github.com/microsoft/onnxruntime/releases/download/v{RUNTIME_VERSION}/{name}.zip"
    );
    let zip = at.join(format!("{name}.zip"));
    let client = client()?;
    let tell = |pct: u64| {
        say(&format!(
            "Downloading ONNX Runtime (once, about 80 MB): {pct}%"
        ));
    };
    block(download(&client, &url, &zip, &tell))
        .map_err(|e| format!("Couldn't download ONNX Runtime: {e}"))?;
    let dll = at.join("onnxruntime.dll");
    let taken = take_out(&zip, &format!("{name}/lib/onnxruntime.dll"), &dll);
    let _ = std::fs::remove_file(&zip); // (only the DLL is needed)
    taken.map_err(|e| format!("Couldn't unpack ONNX Runtime: {e}"))?;
    Ok(dll)
}

/// One file of a zip, into `target` (by way of a .part).
fn take_out(
    zip: &Path,
    inner: &str,
    target: &Path,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut archive = zip::ZipArchive::new(std::fs::File::open(zip)?)?;
    let mut file = archive.by_name(inner)?;
    let part = target.with_extension("part");
    let mut out = std::fs::File::create(&part)?;
    std::io::copy(&mut file, &mut out)?;
    out.flush()?;
    drop(out);
    std::fs::rename(&part, target)?;
    Ok(())
}
