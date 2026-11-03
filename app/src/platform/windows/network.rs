//! The network, as Windows sees it: whether it's one you called Public (where C-Bot won't
//! share a chat), and a URL scheme (cbot://) that opens C-Bot. Both through Windows' own
//! tools, run without a window.

use std::io;
use std::net::IpAddr;
use std::path::Path;
use std::process::Command;

use super::process::NoWindow;
use super::registry;

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
    if registry::default_value(&format!(r"{key}\shell\open\command"))?.contains(&open) {
        return Ok(());
    }
    registry::set(&key, None, &format!("URL:{description}"))?;
    registry::set(&key, Some("URL Protocol"), "")?;
    registry::set(&format!(r"{key}\shell\open\command"), None, &open)
}
