//! Finding the `claude` command without asking the user (src/main/findClaude.js).
//!
//! An app started from the Start menu or a shortcut often has a stale PATH (Windows
//! hands out the PATH from when you signed in, so a Claude Code installed since is
//! invisible). So look in every usual install spot first, then a fresh PATH, and last
//! the copy of Claude Code the Claude desktop app keeps for itself, which is all many
//! people have. The answer is cached; it's checked again only if the file goes.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

use crate::platform::process;
use crate::platform::process::NoWindow;
use crate::runtime::paths;

const NAMES: [&str; 2] = ["claude.exe", "claude.cmd"];

#[derive(Clone)]
pub struct Found {
    pub path: PathBuf,
    pub source: String, // how it got there (shown in the Workshop)
}

fn is_file(p: &Path) -> bool {
    p.is_file()
}

fn dirs(dir: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter(|e| e.path().is_dir())
                .map(|e| e.path())
                .collect()
        })
        .unwrap_or_default()
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

/// "2.1.308" before "2.1.304" before "2.0.99"; names that aren't versions last.
fn newest_first(a: &Path, b: &Path) -> std::cmp::Ordering {
    let parts = |p: &Path| -> Vec<i64> {
        p.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .split('.')
            .map(|x| x.parse().unwrap_or(-1))
            .collect()
    };
    let (va, vb) = (parts(a), parts(b));
    for i in 0..va.len().max(vb.len()) {
        let (x, y) = (
            va.get(i).copied().unwrap_or(-1),
            vb.get(i).copied().unwrap_or(-1),
        );
        if x != y {
            return y.cmp(&x);
        }
    }
    std::cmp::Ordering::Equal
}

/// Where installers put it.
fn install_spots() -> Vec<(PathBuf, &'static str)> {
    let (home, local, roaming) = (paths::home(), paths::local_data(), paths::data());
    let mut spots = vec![
        (home.join(".local").join("bin"), "Claude Code installer"),
        (
            home.join(".claude").join("local"),
            "Claude Code (local install)",
        ),
        (
            home.join(".claude")
                .join("local")
                .join("node_modules")
                .join(".bin"),
            "Claude Code (local install)",
        ),
    ];
    if let Some(prefix) = env_path("npm_config_prefix") {
        spots.push((prefix, "npm"));
    }
    spots.push((roaming.join("npm"), "npm"));
    if let Some(nvm) = env_path("NVM_SYMLINK") {
        spots.push((nvm, "npm (nvm)"));
    }
    spots.push((PathBuf::from("C:\\nvm4w\\nodejs"), "npm (nvm)"));
    spots.push((
        env_path("ProgramFiles")
            .unwrap_or_else(|| "C:\\Program Files".into())
            .join("nodejs"),
        "npm",
    ));
    spots.push((local.join("Volta").join("bin"), "Volta"));
    spots.push((local.join("pnpm"), "pnpm"));
    spots.push((local.join("Yarn").join("bin"), "Yarn"));
    spots.push((home.join("scoop").join("shims"), "Scoop"));
    spots.push((
        local.join("Microsoft").join("WinGet").join("Links"),
        "WinGet",
    ));
    spots.push((home.join(".bun").join("bin"), "Bun"));
    spots
}

/// The PATH as it is now, not as it was when this app started: read fresh from the
/// registry (user + machine).
fn fresh_path() -> Vec<PathBuf> {
    let mut parts = vec![std::env::var("PATH").unwrap_or_default()];
    // (reg.exe by its full path: with a bare PATH, plain `reg` isn't found either)
    let reg = env_path("SystemRoot")
        .unwrap_or_else(|| "C:\\Windows".into())
        .join("System32")
        .join("reg.exe");
    for key in [
        "HKCU\\Environment",
        "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
    ] {
        let Ok(out) = Command::new(&reg)
            .args(["query", key, "/v", "Path"])
            .no_window()
            .output()
        else {
            continue;
        };
        let text = String::from_utf8_lossy(&out.stdout);
        let line = text
            .lines()
            .find(|l| l.trim_start().to_ascii_lowercase().starts_with("path"));
        if let Some(value) = line
            .and_then(|l| l.split_once("REG_").map(|(_, rest)| rest))
            .and_then(|r| r.split_once(char::is_whitespace))
        {
            parts.push(expand_vars(value.1.trim()));
        }
    }
    let mut seen = std::collections::HashSet::new();
    parts
        .join(";")
        .split(';')
        .map(|d| d.trim().trim_matches('"').to_string())
        .filter(|d| !d.is_empty() && seen.insert(d.to_ascii_lowercase()))
        .map(PathBuf::from)
        .collect()
}

/// %NAME% from the environment (left as it is when it isn't set).
fn expand_vars(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) => {
                let name = &after[..end];
                match std::env::var(name) {
                    Ok(v) => out.push_str(&v),
                    Err(_) => out.push_str(&format!("%{name}%")),
                }
                rest = &after[end + 1..];
            }
            None => {
                out.push_str(&rest[start..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

/// The Claude desktop app downloads its own Claude Code, one folder per version:
///   …\Claude-Data\claude_<id>\claude-code\<version>\<build>\claude.exe  (Microsoft Store app)
///   …\Claude\claude-code\<version>\claude.exe                           (older layout)
/// The newest version wins.
fn desktop_app_copies() -> Vec<PathBuf> {
    let (local, roaming) = (paths::local_data(), paths::data());
    let mut roots: Vec<PathBuf> = dirs(&local.join("Claude-Data"))
        .into_iter()
        .map(|d| d.join("claude-code"))
        .collect();
    roots.push(roaming.join("Claude").join("claude-code"));
    roots.push(local.join("Claude").join("claude-code"));
    for d in dirs(&local.join("Packages")) {
        if d.file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.to_ascii_lowercase().starts_with("claude_"))
        {
            roots.push(
                d.join("LocalCache")
                    .join("Roaming")
                    .join("Claude")
                    .join("claude-code"),
            );
        }
    }
    let mut found: Vec<(PathBuf, PathBuf)> = vec![];
    for root in roots {
        for ver in dirs(&root) {
            let mut candidates: Vec<PathBuf> = NAMES.iter().map(|n| ver.join(n)).collect();
            for build in dirs(&ver) {
                candidates.extend(NAMES.iter().map(|n| build.join(n)));
            }
            if let Some(hit) = candidates.into_iter().find(|p| is_file(p)) {
                found.push((ver, hit));
            }
        }
    }
    found.sort_by(|a, b| newest_first(&a.0, &b.0));
    found.into_iter().map(|(_, f)| f).collect()
}

/// Every place it looks, in order; the first real file is the answer.
fn search() -> Option<Found> {
    for (dir, source) in install_spots() {
        for n in NAMES {
            if is_file(&dir.join(n)) {
                return Some(Found {
                    path: dir.join(n),
                    source: source.into(),
                });
            }
        }
    }
    for dir in fresh_path() {
        for n in NAMES {
            if is_file(&dir.join(n)) {
                return Some(Found {
                    path: dir.join(n),
                    source: "PATH".into(),
                });
            }
        }
    }
    desktop_app_copies().into_iter().next().map(|path| Found {
        path,
        source: "Claude desktop app".into(),
    })
}

static CACHED: Mutex<Option<Found>> = Mutex::new(None);

/// Where it is. `chosen` is the path the user picked (it wins while it exists);
/// `fresh` skips the cache (the Workshop's "Search again").
pub fn locate(chosen: &str, fresh: bool) -> Option<Found> {
    if !chosen.is_empty() && is_file(Path::new(chosen)) {
        return Some(Found {
            path: chosen.into(),
            source: "picked by you".into(),
        });
    }
    let mut cached = CACHED.lock().unwrap();
    if !fresh && let Some(c) = cached.as_ref().filter(|c| is_file(&c.path)) {
        return Some(c.clone());
    }
    *cached = search();
    cached.clone()
}

/// The path only (what starting it needs).
pub fn find(chosen: &str) -> Option<PathBuf> {
    locate(chosen, false).map(|f| f.path)
}

/// Is this really Claude Code? Runs `<file> --version`: its version line, or what's wrong
/// in words for the Workshop (findClaude.js checkClaude).
pub fn check(file: &Path) -> Result<String, String> {
    use std::io::Read;
    use std::process::Stdio;
    use std::time::{Duration, Instant};
    if !is_file(file) {
        return Err("That file doesn't exist.".into());
    }
    let not_claude = || {
        "That doesn't look like Claude Code (it didn't answer `--version` like Claude Code does)."
            .to_string()
    };
    // (a .cmd runs through cmd.exe: std does that, quoting it safely)
    let Ok(mut child) = Command::new(file)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .no_window()
        .spawn()
    else {
        return Err(not_claude());
    };
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < Duration::from_secs(15) => {
                std::thread::sleep(Duration::from_millis(50))
            }
            _ => {
                process::kill_tree(child.id());
                let _ = child.wait();
                return Err("It took too long to answer.".into());
            }
        }
    };
    let mut out = String::new();
    if let Some(mut stdout) = child.stdout.take() {
        let _ = stdout.read_to_string(&mut out);
    }
    let out = out.trim();
    if status.success() && out.to_ascii_lowercase().contains("claude") {
        Ok(out.lines().next().unwrap_or(out).trim().to_string())
    } else {
        Err(not_claude())
    }
}
