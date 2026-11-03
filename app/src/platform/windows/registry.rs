//! This Windows user's registry (HKCU), through Windows' own `reg` tool run without a window:
//! what links (network.rs) and Explorer's right-click menu (explorer.rs) open C-Bot with.

use std::io;
use std::process::Command;

use super::process::NoWindow;

/// A key's unnamed (default) value, or "" when it isn't there.
pub(super) fn default_value(key: &str) -> io::Result<String> {
    let out = Command::new("reg")
        .args(["query", key, "/ve"])
        .no_window()
        .output()?;
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Set a string value (name None: the key's default one), making the key if it isn't there.
pub(super) fn set(key: &str, name: Option<&str>, value: &str) -> io::Result<()> {
    let mut c = Command::new("reg");
    c.args(["add", key]);
    match name {
        Some(n) => c.args(["/v", n]),
        None => c.arg("/ve"),
    };
    let ok = c
        .args(["/t", "REG_SZ", "/d", value, "/f"])
        .no_window()
        .output()?
        .status
        .success();
    if ok {
        Ok(())
    } else {
        Err(io::Error::other(format!("reg add {key} failed")))
    }
}
