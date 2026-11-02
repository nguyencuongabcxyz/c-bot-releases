//! diagnostics: what the project's own compilers say about its code now, in short: each error
//! (and, asked, each warning) with its file, line and column, from `cargo check`, `tsc
//! --noEmit`, `dotnet build` and `go vet`, run in each project the changed files (or the paths
//! asked about) belong to, errors in the changed files first. Their whole output, many times
//! longer, is what a conversation would read otherwise. Nothing is installed or downloaded: a
//! checker the project doesn't have (TypeScript without node_modules) is said to be missing.

use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::LazyLock;

use regex::Regex;

use super::*;
use crate::platform::process::NoWindow;

/// How long one checker may take (a project's first check builds all it depends on).
const TIMEOUT: Duration = Duration::from_secs(600);
/// The diagnostics shown, at most.
const SHOWN: usize = 60;

/// A compiler's checker of a project: which, and the folder it runs in (relative to the root).
#[derive(Clone, Debug, PartialEq, Eq)]
enum Checker {
    Cargo(String),
    Tsc(String),
    Dotnet(String),
    Go(String),
}

/// One thing a checker said about a line.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Diag {
    file: String, // (relative to the root, with /)
    line: u32,
    col: u32,
    error: bool,
    code: String,
    message: String,
}

/// diagnostics: the checkers of the projects `paths` belong to (none: the files changed and not
/// committed), what they say; warnings too when asked.
pub fn diagnostics(
    app: &AppHandle,
    id: &str,
    paths: &[String],
    warnings: bool,
) -> Result<String, Error> {
    let f = fresh(app, id)?;
    let root = f.root.clone();
    let files: Vec<String> = if paths.is_empty() {
        let (diff, new) = history::changes(&root, "")?;
        changed_files(&diff).into_iter().chain(new).collect()
    } else {
        paths
            .iter()
            .filter_map(|p| ingest::asked_path(&root, p))
            .collect()
    };
    if files.is_empty() {
        return Ok("Nothing changed and no path given: nothing to check.".into());
    }
    Ok(report(&root, &files, warnings))
}

/// What the checkers of the projects `files` are in say.
fn report(root: &Path, files: &[String], warnings: bool) -> String {
    let checkers = checkers_of(root, files);
    if checkers.is_empty() {
        return format!(
            "No checker C-Bot runs covers these ({}): it checks Rust, TypeScript, C# and Go projects.",
            files.iter().take(5).cloned().collect::<Vec<_>>().join(", ")
        );
    }
    let mut out = String::new();
    let mut all: Vec<Diag> = vec![];
    for c in &checkers {
        let (line, found) = check(root, c);
        out.push_str(&line);
        all.extend(found);
    }
    out.push_str(&listed(&mut all, files, warnings));
    out
}

/// The files a `git diff` changed (by their new path).
fn changed_files(diff: &str) -> Vec<String> {
    diff.lines()
        .filter_map(|l| l.strip_prefix("+++ b/"))
        .map(str::to_string)
        .collect()
}

/// The checker of each project the files are in, each once: the nearest Cargo.toml above a
/// Rust file, tsconfig.json above a TypeScript one, .csproj above a C# one, go.mod above a Go
/// one (a folder: whichever it holds, or is in).
fn checkers_of(root: &Path, files: &[String]) -> Vec<Checker> {
    let mut out: Vec<Checker> = vec![];
    for rel in files {
        let ext = rel.rsplit_once('.').map_or("", |(_, e)| e);
        let folder = root.join(rel).is_dir();
        let wanted: Vec<fn(String) -> Checker> = match ext {
            _ if folder => vec![Checker::Cargo, Checker::Tsc, Checker::Dotnet, Checker::Go],
            "rs" | "toml" => vec![Checker::Cargo],
            "ts" | "tsx" | "mts" | "cts" => vec![Checker::Tsc],
            "cs" | "csproj" => vec![Checker::Dotnet],
            "go" => vec![Checker::Go],
            _ => vec![],
        };
        let start = if folder { rel.as_str() } else { dir_of(rel) };
        for make in wanted {
            let marker = |dir: &str| match make(String::new()) {
                Checker::Cargo(_) => root.join(dir).join("Cargo.toml").is_file(),
                Checker::Tsc(_) => root.join(dir).join("tsconfig.json").is_file(),
                Checker::Go(_) => root.join(dir).join("go.mod").is_file(),
                Checker::Dotnet(_) => std::fs::read_dir(root.join(dir)).is_ok_and(|d| {
                    d.flatten()
                        .any(|e| e.file_name().to_string_lossy().ends_with(".csproj"))
                }),
            };
            if let Some(dir) = nearest(start, &marker) {
                let c = make(dir);
                if !out.contains(&c) {
                    out.push(c);
                }
            }
        }
    }
    out
}

fn dir_of(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(d, _)| d)
}

/// The nearest folder from `start` up to the root ('') that `has` takes.
fn nearest(start: &str, has: &dyn Fn(&str) -> bool) -> Option<String> {
    let mut dir = start.trim_matches('/');
    loop {
        if has(dir) {
            return Some(dir.to_string());
        }
        if dir.is_empty() {
            return None;
        }
        dir = dir_of(dir);
    }
}

/// Runs a checker: its line for the answer (what ran, what it found, how long), and what it said.
fn check(root: &Path, c: &Checker) -> (String, Vec<Diag>) {
    let (name, dir) = match c {
        Checker::Cargo(d) => ("cargo check", d),
        Checker::Tsc(d) => ("tsc", d),
        Checker::Dotnet(d) => ("dotnet build", d),
        Checker::Go(d) => ("go vet", d),
    };
    let at = root.join(dir);
    let shown = if dir.is_empty() { "." } else { dir.as_str() };
    let words = |w: &[&str]| w.iter().map(|s| (*s).to_string()).collect::<Vec<String>>();
    let (program, args): (PathBuf, Vec<String>) = match c {
        Checker::Cargo(_) => (
            "cargo".into(),
            words(&[
                "check",
                "--all-targets",
                "--message-format=short",
                "--color",
                "never",
            ]),
        ),
        Checker::Tsc(_) => match tsc_in(root, dir) {
            Some((tsc, mut before)) => {
                before.extend(words(&["--noEmit", "--pretty", "false"]));
                (tsc, before)
            }
            None => {
                return (
                    format!(
                        "{name} ({shown}): not run, TypeScript isn't installed in its node_modules\n"
                    ),
                    vec![],
                );
            }
        },
        Checker::Dotnet(_) => (
            "dotnet".into(),
            words(&["build", "-nologo", "-v", "q", "-clp:NoSummary"]),
        ),
        Checker::Go(_) => ("go".into(), words(&["vet", "./..."])),
    };
    let started = Instant::now();
    let ran = run(&at, &program, &args);
    let took = started.elapsed().as_secs();
    let text = match ran {
        Ok((text, false)) => text,
        Ok((_, true)) => {
            return (
                format!(
                    "{name} ({shown}): stopped after {} s (a first check builds everything the project depends on: run it once in a terminal, then ask again)\n",
                    TIMEOUT.as_secs()
                ),
                vec![],
            );
        }
        Err(e) => return (format!("{name} ({shown}): couldn't run it: {e}\n"), vec![]),
    };
    let found = match c {
        Checker::Cargo(_) => cargo_diags(&text, dir),
        Checker::Tsc(_) => tsc_diags(&text, dir),
        Checker::Dotnet(_) => dotnet_diags(&text, root),
        Checker::Go(_) => go_diags(&text, dir),
    };
    let errors = found.iter().filter(|d| d.error).count();
    let warnings = found.len() - errors;
    let many = |n: usize, what: &str| format!("{n} {what}{}", if n == 1 { "" } else { "s" });
    let said = match (errors, warnings) {
        (0, 0) => "no errors".to_string(),
        (e, 0) => many(e, "error"),
        (e, w) => format!("{}, {}", many(e, "error"), many(w, "warning")),
    };
    (format!("{name} ({shown}): {said} ({took} s)\n"), found)
}

/// The project's own TypeScript compiler, in node_modules in its folder or one above it: the
/// launcher its package manager made (npm's and pnpm's tsc.cmd, bun's tsc.exe, tsc elsewhere),
/// else TypeScript's own script run by node. With the arguments that come before tsc's own.
fn tsc_in(root: &Path, dir: &str) -> Option<(PathBuf, Vec<String>)> {
    let found = nearest(dir, &|d| {
        root.join(d)
            .join("node_modules")
            .join("typescript")
            .is_dir()
    })?;
    let modules = root.join(found).join("node_modules");
    let bin = modules.join(".bin");
    let launcher = ["tsc.cmd", "tsc.exe", "tsc"]
        .iter()
        .map(|n| bin.join(n))
        .find(|p| p.is_file());
    if let Some(p) = launcher {
        return Some((p, vec![]));
    }
    let script = modules.join("typescript").join("bin").join("tsc");
    let script = script
        .is_file()
        .then(|| script.to_string_lossy().into_owned())?;
    Some(("node".into(), vec![script]))
}

/// A program run in `dir`, all it wrote (out and err together), and whether it was stopped
/// for taking longer than TIMEOUT.
fn run(dir: &Path, program: &Path, args: &[String]) -> Result<(String, bool), Error> {
    let mut child = Command::new(program)
        .args(args)
        .current_dir(dir)
        .env("CARGO_TERM_COLOR", "never")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .no_window()
        .spawn()
        .map_err(|e| format!("{} isn't on the PATH ({e})", program.display()))?;
    // (both read as it writes, so a full pipe never stops it)
    let pipe = |r: Option<Box<dyn Read + Send>>| {
        thread::spawn(move || {
            let mut text = String::new();
            if let Some(mut r) = r {
                let mut bytes = vec![];
                let _ = r.read_to_end(&mut bytes);
                text = String::from_utf8_lossy(&bytes).into_owned();
            }
            text
        })
    };
    let out = pipe(
        child
            .stdout
            .take()
            .map(|o| Box::new(o) as Box<dyn Read + Send>),
    );
    let err = pipe(
        child
            .stderr
            .take()
            .map(|e| Box::new(e) as Box<dyn Read + Send>),
    );
    let deadline = Instant::now() + TIMEOUT;
    let mut stopped = false;
    while child.try_wait()?.is_none() {
        if Instant::now() > deadline {
            let _ = child.kill();
            stopped = true;
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }
    let _ = child.wait();
    let text = format!(
        "{}\n{}",
        out.join().unwrap_or_default(),
        err.join().unwrap_or_default()
    );
    Ok((text, stopped))
}

/// A path a checker gave, relative to the root with `/` (relative to `dir` when not absolute).
fn rooted(dir: &str, path: &str) -> String {
    let path = path.trim().replace('\\', "/");
    let path = path.strip_prefix("./").unwrap_or(&path);
    if dir.is_empty() {
        path.to_string()
    } else {
        format!("{dir}/{path}")
    }
}

/// `cargo check --message-format=short`: `src/a.rs:3:5: error[E0425]: cannot find value`.
fn cargo_diags(text: &str, dir: &str) -> Vec<Diag> {
    static LINE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^(.+?):(\d+):(\d+): (error|warning)(?:\[(\w+)\])?: (.+)$")
            .expect("a constant regex")
    });
    parsed(text, &LINE, |c| rooted(dir, &c[1]))
}

/// `tsc --pretty false`: `src/a.ts(3,5): error TS2304: Cannot find name 'x'.`
fn tsc_diags(text: &str, dir: &str) -> Vec<Diag> {
    static LINE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.+)$")
            .expect("a constant regex")
    });
    parsed(text, &LINE, |c| rooted(dir, &c[1]))
}

/// `dotnet build`: `C:\x\A.cs(3,5): error CS0103: The name 'x' does not exist [C:\x\A.csproj]`
/// (MSBuild says each twice: once).
fn dotnet_diags(text: &str, root: &Path) -> Vec<Diag> {
    static LINE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^\s*(.+?)\((\d+),(\d+)\): (error|warning) (\w+): (.+?)(?: \[[^\]]+\])?$")
            .expect("a constant regex")
    });
    let base = root.to_string_lossy().replace('\\', "/");
    let base = format!("{}/", base.trim_end_matches('/'));
    let mut out = parsed(text, &LINE, |c| {
        let path = c[1].replace('\\', "/");
        path.strip_prefix(&base).unwrap_or(&path).to_string()
    });
    let mut seen = HashSet::new();
    out.retain(|d| seen.insert((d.file.clone(), d.line, d.col, d.message.clone())));
    out
}

/// `go vet`: `./a.go:3:5: undefined: x` (always an error).
fn go_diags(text: &str, dir: &str) -> Vec<Diag> {
    static LINE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^(?:vet: )?(.+?\.go):(\d+):(\d+): ()()(.+)$").expect("a constant regex")
    });
    parsed(text, &LINE, |c| rooted(dir, &c[1]))
        .into_iter()
        .map(|d| Diag { error: true, ..d })
        .collect()
}

/// Each line `re` reads: (1) the file, (2) line, (3) column, (4) error or warning, (5) its
/// code, (6) its message.
fn parsed(text: &str, re: &Regex, file: impl Fn(&regex::Captures) -> String) -> Vec<Diag> {
    text.lines()
        .filter_map(|l| re.captures(l.trim_end()))
        .map(|c| Diag {
            file: file(&c),
            line: c[2].parse().unwrap_or(0),
            col: c[3].parse().unwrap_or(0),
            error: &c[4] != "warning",
            code: c.get(5).map_or("", |m| m.as_str()).to_string(),
            message: c[6].trim().to_string(),
        })
        .collect()
}

/// The diagnostics, errors first and those in the changed files first of all; warnings shown
/// only when asked (else counted above).
fn listed(all: &mut [Diag], changed: &[String], warnings: bool) -> String {
    let touched = |d: &Diag| {
        changed
            .iter()
            .any(|c| d.file == *c || d.file.starts_with(&format!("{c}/")))
    };
    all.sort_by_key(|d| (!d.error, !touched(d), d.file.clone(), d.line, d.col));
    let shown: Vec<&Diag> = all.iter().filter(|d| d.error || warnings).collect();
    let mut out = String::new();
    for d in shown.iter().take(SHOWN) {
        let kind = if d.error { "error" } else { "warning" };
        let code = if d.code.is_empty() {
            String::new()
        } else {
            format!("[{}]", d.code)
        };
        out.push_str(&format!(
            "  {}:{}:{}  {kind}{code} {}\n",
            d.file,
            d.line,
            d.col,
            parse::cut(&d.message, 240)
        ));
    }
    if shown.len() > SHOWN {
        out.push_str(&format!("  … and {} more\n", shown.len() - SHOWN));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cargos_short_messages_are_read_with_their_codes() {
        let text = "    Checking c-bot v2.4.7 (C:\\x\\app)\nsrc/a.rs:3:5: error[E0425]: cannot find value `y` in this scope\nsrc\\b.rs:10:1: warning: unused import: `std::io`\nerror: could not compile `c-bot` due to 1 previous error\n";
        let got = cargo_diags(text, "app");
        assert_eq!(got.len(), 2);
        assert_eq!(
            got[0],
            Diag {
                file: "app/src/a.rs".into(),
                line: 3,
                col: 5,
                error: true,
                code: "E0425".into(),
                message: "cannot find value `y` in this scope".into(),
            }
        );
        assert_eq!(
            (got[1].file.as_str(), got[1].error),
            ("app/src/b.rs", false)
        );
    }

    #[test]
    fn tsc_dotnet_and_go_are_read_too() {
        let ts = tsc_diags("src/a.ts(3,5): error TS2304: Cannot find name 'x'.\n", "");
        assert_eq!(
            (ts[0].file.as_str(), ts[0].code.as_str()),
            ("src/a.ts", "TS2304")
        );
        let cs = "C:\\work\\shop\\Api\\A.cs(3,5): error CS0103: The name 'x' does not exist in the current context [C:\\work\\shop\\Api\\Api.csproj]\nC:\\work\\shop\\Api\\A.cs(3,5): error CS0103: The name 'x' does not exist in the current context [C:\\work\\shop\\Api\\Api.csproj]\n";
        let cs = dotnet_diags(cs, Path::new("C:\\work\\shop"));
        assert_eq!(cs.len(), 1);
        assert_eq!(cs[0].file, "Api/A.cs");
        assert_eq!(
            cs[0].message,
            "The name 'x' does not exist in the current context"
        );
        let go = go_diags("# shop/store\n./store.go:12:2: undefined: Open\n", "store");
        assert_eq!(
            (go[0].file.as_str(), go[0].line, go[0].error),
            ("store/store.go", 12, true)
        );
    }

    #[test]
    fn errors_in_the_changed_files_come_first_and_warnings_only_when_asked() {
        let d = |file: &str, error: bool| Diag {
            file: file.into(),
            line: 1,
            col: 1,
            error,
            code: String::new(),
            message: "m".into(),
        };
        let mut all = vec![d("b.rs", false), d("a.rs", true), d("c.rs", true)];
        let got = listed(&mut all, &["c.rs".to_string()], false);
        assert_eq!(got, "  c.rs:1:1  error m\n  a.rs:1:1  error m\n");
        assert!(listed(&mut all, &[], true).ends_with("  b.rs:1:1  warning m\n"));
    }

    #[test]
    fn each_file_is_checked_by_its_projects_checker_once() {
        let dir = std::env::temp_dir().join(format!(
            "cbot-ctx-diagnose-{}",
            uuid::Uuid::new_v4().simple()
        ));
        for (p, text) in [
            ("app/Cargo.toml", "[package]\n"),
            ("app/src/a.rs", ""),
            ("tsconfig.json", "{}"),
            ("gui/x.ts", ""),
        ] {
            let path = dir.join(p);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
        let files: Vec<String> = ["app/src/a.rs", "app/src/b.rs", "gui/x.ts", "README.md"]
            .map(String::from)
            .to_vec();
        let got = checkers_of(&dir, &files);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(
            got,
            [Checker::Cargo("app".into()), Checker::Tsc(String::new())]
        );
        assert_eq!(
            changed_files("+++ b/app/src/a.rs\n+++ /dev/null\n"),
            ["app/src/a.rs"]
        );
    }
}
