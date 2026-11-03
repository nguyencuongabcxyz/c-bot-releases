//! Explorer's right-click menu: an entry on folders (and on a folder's empty space) that
//! opens C-Bot with that folder. For this Windows user only; on Windows 11 it's under "Show
//! more options" (the short menu takes only packaged apps' entries).

use std::io;
use std::path::Path;

use super::registry;

/// Right-clicking a folder, or inside one, offers `label`: it runs `exe arg "<the folder>"`.
/// Nothing is written when it already does.
pub fn register_folder_entry(key: &str, label: &str, exe: &Path, arg: &str) -> io::Result<()> {
    let run = format!(r#""{}" {arg} "%V""#, exe.display());
    // (a folder itself, and the empty space inside an open one)
    for under in [r"Directory\shell", r"Directory\Background\shell"] {
        let at = format!(r"HKCU\Software\Classes\{under}\{key}");
        if registry::default_value(&format!(r"{at}\command"))?.contains(&run) {
            continue;
        }
        registry::set(&at, None, label)?;
        registry::set(&at, Some("Icon"), &format!(r#""{}",0"#, exe.display()))?;
        registry::set(&format!(r"{at}\command"), None, &run)?;
    }
    Ok(())
}
