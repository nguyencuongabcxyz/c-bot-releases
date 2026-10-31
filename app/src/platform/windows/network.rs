//! The network, as Windows sees it: whether it's one you called Public (where C-Bot won't
//! share a chat), and a URL scheme (cbot://) that opens C-Bot. Both through Windows' own
//! tools, run without a window.

use std::io;
use std::net::IpAddr;
use std::path::Path;
use std::process::Command;

use super::process::NoWindow;

/// Is the network this address is on one Windows calls Public? None when it can't tell.
pub fn is_public(ip: IpAddr) -> Option<bool> {
    let script = format!(
        "(Get-NetConnectionProfile -InterfaceIndex (Get-NetIPAddress -IPAddress '{ip}' -ErrorAction Stop).InterfaceIndex -ErrorAction Stop).NetworkCategory"
    );
    let out = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .no_window()
        .output()
        .ok()?;
    let category = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !category.is_empty()).then(|| category == "Public")
}

/// Links like `scheme://…` open `exe` with the link as its argument (for this Windows user
/// only). Nothing is written when they already do.
pub fn register_scheme(scheme: &str, description: &str, exe: &Path) -> io::Result<()> {
    let key = format!(r"HKCU\Software\Classes\{scheme}");
    let open = format!(r#""{}" "%1""#, exe.display());
    let now = Command::new("reg")
        .args(["query", &format!(r"{key}\shell\open\command"), "/ve"])
        .no_window()
        .output()?;
    if String::from_utf8_lossy(&now.stdout).contains(&open) {
        return Ok(());
    }
    let set = |sub: &str, name: Option<&str>, value: &str| -> io::Result<()> {
        let path = if sub.is_empty() {
            key.clone()
        } else {
            format!(r"{key}\{sub}")
        };
        let mut c = Command::new("reg");
        c.args(["add", &path]);
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
            Err(io::Error::other(format!("reg add {path} failed")))
        }
    };
    set("", None, &format!("URL:{description}"))?;
    set("", Some("URL Protocol"), "")?;
    set(r"shell\open\command", None, &open)
}
