//! What git remembers of the robot's folder (code_history): the commits that changed a file, a
//! folder or the whole project, newest first, with the files each changed; or, for a symbol,
//! who last changed its lines (git blame), commit by commit. And the folder's branch and last
//! commit, for the chat's details (details.rs). Git is asked as the user has it (`git` on the
//! PATH); a folder that isn't in a repository says so.

use std::process::Command;

use super::*;
use crate::platform::process::NoWindow;

/// Between the fields git gives of a commit, and before each commit.
const FIELD: char = '\u{1f}';
const RECORD: char = '\u{1e}';
/// The files listed under a commit, at most.
const FILES_SHOWN: usize = 6;
/// What git calls a line nobody has committed yet.
const UNCOMMITTED: &str = "0000000000000000000000000000000000000000";

/// The branch a folder is on and its last commit, as the chat shows them.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitInfo {
    pub branch: String,
    pub head: String,    // (its short hash)
    pub subject: String, // (its first line)
    pub author: String,
    pub when: String,   // ("3 days ago")
    pub changed: usize, // (files changed and not committed)
}

/// git, in `root`, with these arguments: what it wrote, or why it failed.
fn git(root: &Path, args: &[&str]) -> Result<String, Error> {
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["-c", "core.quotepath=off"])
        .args(args)
        .no_window()
        .output()
        .map_err(|e| format!("Couldn't run git (is it installed?): {e}"))?;
    if !out.status.success() {
        let why = String::from_utf8_lossy(&out.stderr);
        let why = why.lines().next().unwrap_or("").trim();
        return Err(format!("git {}: {why}", args.first().unwrap_or(&"")).into());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// The folder's branch and last commit (None outside a repository, or with no commit yet).
pub(super) fn info(root: &Path) -> Option<GitInfo> {
    let branch = git(root, &["rev-parse", "--abbrev-ref", "HEAD"]).ok()?;
    let format = format!("--format=%h{FIELD}%s{FIELD}%an{FIELD}%ar");
    let last = git(root, &["log", "-1", &format]).ok()?;
    let mut f = last.trim().split(FIELD);
    let mut next = || f.next().unwrap_or("").to_string();
    let (head, subject, author, when) = (next(), next(), next(), next());
    let changed = git(root, &["status", "--porcelain"])
        .map(|s| s.lines().count())
        .unwrap_or(0);
    Some(GitInfo {
        branch: branch.trim().to_string(),
        head,
        subject,
        author,
        when,
        changed,
    })
}

// ---------------------------------------------------------------- code_history

/// code_history: a symbol's lines, commit by commit (`symbol`), or the latest `limit` commits
/// that changed a file or folder (`path`; '' for the whole project).
pub fn code_history(
    app: &AppHandle,
    id: &str,
    path: &str,
    symbol: &str,
    limit: usize,
) -> Result<String, Error> {
    let f = fresh(app, id)?;
    if !symbol.trim().is_empty() {
        let g = graph_of(&f);
        let Some(&s) = g.resolve_name(symbol.trim(), "").first() else {
            return Err(format!("Nothing called \"{symbol}\" is defined here.").into());
        };
        let sym = &g.syms[s];
        let head = format!(
            "{} {} — {}:{}-{}",
            sym.kind.word(),
            sym.fqn,
            g.path(s),
            sym.line,
            sym.end
        );
        return blame(&f.root, g.path(s), sym.line, sym.end, &head, limit);
    }
    let rel = match path.trim() {
        "" | "." => String::new(),
        p => ingest::asked_path(&f.root, p)
            .ok_or_else(|| format!("{p} isn't in this robot's folder ({}).", f.root.display()))?,
    };
    log(&f.root, &rel, limit)
}

/// The latest `limit` commits that changed `rel` ('' for anywhere), each with its files.
fn log(root: &Path, rel: &str, limit: usize) -> Result<String, Error> {
    let format = format!("--format={RECORD}%h{FIELD}%ad{FIELD}%an{FIELD}%s");
    let n = limit.to_string();
    let mut args = vec!["log", "-n", &n, "--date=short", &format, "--name-only"];
    // (a file is followed through its renames)
    if root.join(rel).is_file() {
        args.push("--follow");
    }
    args.extend(["--", if rel.is_empty() { "." } else { rel }]);
    let out = git(root, &args)?;
    let commits = commits(&out);
    let what = if rel.is_empty() { "the project" } else { rel };
    if commits.is_empty() {
        return Ok(format!("No commit has changed {what}."));
    }
    let mut text = format!(
        "{what}: the latest {} commits that changed it, newest first\n",
        commits.len()
    );
    for c in commits {
        text.push_str(&format!(
            "{} {} {}  {}\n",
            c.hash, c.date, c.author, c.subject
        ));
        if !c.files.is_empty() {
            let more = c.files.len().saturating_sub(FILES_SHOWN);
            let shown: Vec<&str> = c
                .files
                .iter()
                .take(FILES_SHOWN)
                .map(String::as_str)
                .collect();
            let more = if more > 0 {
                format!(" (+{more} more)")
            } else {
                String::new()
            };
            text.push_str(&format!("    {}{more}\n", shown.join(", ")));
        }
    }
    Ok(text)
}

/// A commit as `log` reads it.
#[derive(Debug, PartialEq)]
struct Commit {
    hash: String,
    date: String,
    author: String,
    subject: String,
    files: Vec<String>,
}

/// The commits in what `git log --format=<RECORD>…<FIELD>… --name-only` wrote.
fn commits(out: &str) -> Vec<Commit> {
    out.split(RECORD)
        .filter(|r| !r.trim().is_empty())
        .map(|r| {
            let mut lines = r.lines();
            let mut f = lines.next().unwrap_or("").split(FIELD);
            let mut next = || f.next().unwrap_or("").to_string();
            Commit {
                hash: next(),
                date: next(),
                author: next(),
                subject: next(),
                files: lines
                    .filter(|l| !l.trim().is_empty())
                    .map(str::to_string)
                    .collect(),
            }
        })
        .collect()
}

/// Who last changed lines `from..=to` of `rel`: each commit with how many of them, newest
/// first, at most `limit`.
fn blame(
    root: &Path,
    rel: &str,
    from: u32,
    to: u32,
    head: &str,
    limit: usize,
) -> Result<String, Error> {
    let range = format!("{from},{to}");
    let out = git(root, &["blame", "--porcelain", "-L", &range, "--", rel])?;
    let lines = blamed(&out);
    let total: usize = lines.iter().map(|(_, n)| n).sum();
    let mut text = format!("{head}: who last changed its {total} lines\n");
    let shas: Vec<&str> = lines
        .iter()
        .map(|(s, _)| s.as_str())
        .filter(|s| *s != UNCOMMITTED)
        .collect();
    let mut known: HashMap<String, String> = HashMap::new();
    if !shas.is_empty() {
        let format = format!("--format=%H{FIELD}%h %ad %an  %s");
        let mut args = vec!["show", "-s", "--date=short", &format];
        args.extend(&shas);
        for line in git(root, &args)?.lines() {
            if let Some((sha, about)) = line.split_once(FIELD) {
                known.insert(sha.to_string(), about.to_string());
            }
        }
    }
    let mut rows: Vec<(&str, usize)> = lines.iter().map(|(s, n)| (s.as_str(), *n)).collect();
    // (newest first: `git show` gives dates; the uncommitted lines, newest of all, lead)
    rows.sort_by_key(|(s, _)| {
        std::cmp::Reverse(known.get(*s).map(|a| date_of(a)).unwrap_or("9999"))
    });
    for (sha, n) in rows.into_iter().take(limit) {
        let about = known.get(sha).map_or("not committed yet", String::as_str);
        text.push_str(&format!("{about}  ({n} of {total} lines)\n"));
    }
    Ok(text)
}

/// The date in a commit line `show` gave ("<short hash> <date> …").
fn date_of(about: &str) -> &str {
    about.split(' ').nth(1).unwrap_or("")
}

/// Each commit in what `git blame --porcelain` wrote, with how many of the lines it last
/// changed (in the order first seen).
fn blamed(out: &str) -> Vec<(String, usize)> {
    let mut counts: Vec<(String, usize)> = vec![];
    for line in out.lines() {
        // (each line of the file comes after a header: "<sha> <old line> <new line>[ <count>]")
        let mut parts = line.split(' ');
        let Some(sha) = parts
            .next()
            .filter(|s| s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit()))
        else {
            continue;
        };
        if parts.count() < 2 {
            continue;
        }
        match counts.iter_mut().find(|(s, _)| s == sha) {
            Some((_, n)) => *n += 1,
            None => counts.push((sha.to_string(), 1)),
        }
    }
    counts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_log_is_read_into_commits_with_their_files() {
        let out = format!(
            "{RECORD}a1b2c3d{FIELD}2026-10-29{FIELD}Tri{FIELD}Store: open lazily\n\nsrc/store.rs\nsrc/main.rs\n{RECORD}e4f5a6b{FIELD}2026-10-20{FIELD}An{FIELD}First\n"
        );
        let got = commits(&out);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].hash, "a1b2c3d");
        assert_eq!(got[0].subject, "Store: open lazily");
        assert_eq!(got[0].files, ["src/store.rs", "src/main.rs"]);
        assert!(got[1].files.is_empty());
        assert!(commits("").is_empty());
    }

    #[test]
    fn a_blame_counts_each_commits_lines() {
        let a = "a".repeat(40);
        let b = "b".repeat(40);
        let out = format!(
            "{a} 1 1 2\nauthor Tri\nsummary One\n\tfn open() {{\n{a} 2 2\n\t  load();\n{b} 9 3 1\nauthor An\n\t}}\n"
        );
        assert_eq!(blamed(&out), [(a, 2), (b, 1)]);
    }

    #[test]
    fn a_commit_line_says_its_date_second() {
        assert_eq!(date_of("a1b2c3d 2026-10-29 Tri  Store"), "2026-10-29");
        assert_eq!(date_of(""), "");
    }
}
