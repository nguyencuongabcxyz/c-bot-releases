//! What a robot's tabs are up to, for each other. Its conversations can work in the same folder
//! at the same time, so each one can see what the others are doing (list_tabs), wait for one to
//! finish (wait_for_tab), hears at the start of a turn which others are at work and on what
//! files (meanwhile), and is stopped from changing a file another is changing right now (guard,
//! asked by Claude Code's PreToolUse hook: mcp/guard.rs).

use std::sync::LazyLock;

use super::*;
use crate::runtime::Error;
use crate::store;

const WAIT_DEFAULT: u64 = 10 * 60; // (seconds)
const WAIT_MAX: u64 = 30 * 60;
const POLL: Duration = Duration::from_millis(400);
const ANSWER_MAX: usize = 1500; // (characters of its answer told to the one that waited)
const FILES_SHOWN: usize = 12;

/// The tools that change a file, and the input naming it.
const EDITS: [(&str, &str); 4] = [
    ("Edit", "file_path"),
    ("MultiEdit", "file_path"),
    ("Write", "file_path"),
    ("NotebookEdit", "notebook_path"),
];

// Who waits for whom (tab key -> the tab key it waits for): no two tabs wait for each other.
static WAITS: LazyLock<Mutex<HashMap<String, String>>> = LazyLock::new(Mutex::default);

/// What a tab's turn is on, as it goes (kept in its Book).
#[derive(Default, Clone)]
pub(super) struct Now {
    asked: String,
    doing: String,
    files: Vec<String>, // (the ones it's changing or has changed in this turn, as it named them)
}

impl Now {
    pub(super) fn asked(prompt: &str) -> Now {
        Now {
            asked: first_line(prompt, 120),
            ..Default::default()
        }
    }

    /// A step it takes: what it's doing now, and the file, if it's one that changes one.
    pub(super) fn saw(&mut self, name: &str, detail: &str, args: &Value) {
        self.doing = if detail.is_empty() {
            name.to_string()
        } else {
            format!("{name}: {}", first_line(detail, 80))
        };
        let Some((_, key)) = EDITS.iter().find(|(n, _)| *n == name) else {
            return;
        };
        let file = args[*key].as_str().unwrap_or("");
        if !file.is_empty() && !self.files.iter().any(|f| f == file) {
            self.files.push(file.to_string());
        }
    }
}

/// Another tab, as the others see it.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct Activity {
    pub(super) tab_id: String,
    pub(super) title: String,
    pub(super) busy: bool,
    pub(super) asked: String, // (working: what it was asked; else what it was asked last)
    pub(super) doing: String, // (working: its latest step)
    pub(super) files: Vec<String>, // (working: what it's changing; else what its last answer changed)
}

fn first_line(s: &str, n: usize) -> String {
    let line = s
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("");
    if line.chars().count() > n {
        format!("{}…", line.chars().take(n - 1).collect::<String>())
    } else {
        line.to_string()
    }
}

/// A file as compared (the same file however it was named).
fn same(folder: &str, file: &str) -> String {
    files::normalize(&Path::new(folder).join(file)).to_lowercase()
}

/// A file as shown: inside the folder, from there.
fn shown(folder: &str, file: &str) -> String {
    let full = files::normalize(&Path::new(folder).join(file));
    let base = files::normalize(Path::new(folder));
    // (inside it whatever the case of its letters: the folder's part is cut by length)
    match full.get(base.len()..) {
        Some(rest) if files::is_inside(&full, folder) => {
            rest.trim_start_matches(['\\', '/']).replace('\\', "/")
        }
        _ => full,
    }
}

/// The robot's other tabs (not `except`, nor temporary ones), and what each is up to.
pub(super) fn activities(app: &AppHandle, id: &str, except: &str) -> Vec<Activity> {
    let Some(rows) = with(app, |st| {
        let tabs = st.store.get(id)?["tabs"].as_array()?.clone();
        Some(
            tabs.into_iter()
                .filter(|t| t.id() != except && t["temporary"] != true)
                .map(|t| (st.chats.get(&key_of(id, t.id())).cloned(), t))
                .collect::<Vec<_>>(),
        )
    }) else {
        return vec![];
    };
    rows.into_iter()
        .map(|(chat, t)| {
            let live = chat
                .filter(|c| c.session.busy())
                .map(|c| c.book.locked().now.clone());
            let history = t["history"].as_array().cloned().unwrap_or_default();
            let last = |role: &str| history.iter().rev().find(|h| h["role"] == role);
            let (busy, now) = match live {
                Some(now) => (true, now),
                None => (
                    false,
                    Now {
                        asked: last("user")
                            .map(|h| first_line(h["text"].as_str().unwrap_or(""), 120))
                            .unwrap_or_default(),
                        doing: String::new(),
                        files: last("assistant")
                            .and_then(|h| h["edits"].as_array().cloned())
                            .unwrap_or_default()
                            .iter()
                            .filter_map(|d| d["file"].as_str().map(str::to_string))
                            .collect(),
                    },
                ),
            };
            Activity {
                tab_id: t.id().to_string(),
                title: store::title_for(&t),
                busy,
                asked: now.asked,
                doing: now.doing,
                files: now.files,
            }
        })
        .collect()
}

fn folder_of(app: &AppHandle, id: &str) -> String {
    with(app, |st| st.store.get(id).map(|c| c.folder().to_string())).unwrap_or_default()
}

/// A tab's files as shown, each once (an answer that changed one twice has two edits of it).
fn shown_files(files: &[String], folder: &str) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for f in files.iter().map(|f| shown(folder, f)) {
        if !out.contains(&f) && out.len() < FILES_SHOWN {
            out.push(f);
        }
    }
    out
}

/// One tab, as list_tabs and the meanwhile note show it.
fn line_for(a: &Activity, folder: &str) -> String {
    let files = shown_files(&a.files, folder);
    let mut line = format!("- “{}”: ", a.title);
    if a.busy {
        line += &format!("working on “{}”", a.asked);
        if !a.doing.is_empty() {
            line += &format!("; now {}", a.doing);
        }
        if !files.is_empty() {
            line += &format!("; changing {}", files.join(", "));
        }
    } else {
        line += "idle";
        if !a.asked.is_empty() {
            line += &format!(" (last asked “{}”", a.asked);
            if !files.is_empty() {
                line += &format!("; changed {}", files.join(", "));
            }
            line += ")";
        }
    }
    line
}

// ---------------------------------------------------------------- list_tabs

/// list_tabs: the other tabs and what they're up to.
pub fn list(app: &AppHandle, id: &str, tab: &str) -> String {
    let all = activities(app, id, tab);
    if all.is_empty() {
        return "You have no other tabs open right now.".into();
    }
    let folder = folder_of(app, id);
    let lines: Vec<String> = all.iter().map(|a| line_for(a, &folder)).collect();
    format!(
        "Your other tabs (conversations of yours in this same folder):\n{}",
        lines.join("\n")
    )
}

// ---------------------------------------------------------------- meanwhile

/// What a turn starting in `tab` hears about the others at work (none: nothing).
pub fn meanwhile(app: &AppHandle, id: &str, tab: &str) -> String {
    let busy: Vec<Activity> = activities(app, id, tab)
        .into_iter()
        .filter(|a| a.busy)
        .collect();
    meanwhile_note(&busy, &folder_of(app, id))
}

fn meanwhile_note(busy: &[Activity], folder: &str) -> String {
    if busy.is_empty() {
        return String::new();
    }
    let lines: Vec<String> = busy.iter().map(|a| line_for(a, folder)).collect();
    format!(
        "\n\n[Meanwhile, other tabs of yours are working in this same folder:\n{}\nDon't change a file one of them is changing: wait for it with wait_for_tab (then read the file again), or do the rest first.]",
        lines.join("\n")
    )
}

// ---------------------------------------------------------------- the guard

/// Before `tab` changes `file`: why not (another tab is changing it right now), or nothing.
pub fn guard(app: &AppHandle, id: &str, tab: &str, file: &str) -> Option<String> {
    let folder = folder_of(app, id);
    let busy: Vec<Activity> = activities(app, id, tab)
        .into_iter()
        .filter(|a| a.busy)
        .collect();
    guard_for(&busy, &folder, file)
}

fn guard_for(busy: &[Activity], folder: &str, file: &str) -> Option<String> {
    if file.is_empty() {
        return None;
    }
    let target = same(folder, file);
    let other = busy
        .iter()
        .find(|a| a.files.iter().any(|f| same(folder, f) == target))?;
    Some(format!(
        "Your other tab “{}” is changing {} right now (it's working on “{}”). Don't change it at the same time: call wait_for_tab with tab “{}” to wait till it's done, then read the file again before you change it. Or do the rest of your work first.",
        other.title,
        shown(folder, file),
        other.asked,
        other.title
    ))
}

// ---------------------------------------------------------------- wait_for_tab

/// The tab named `name` (its title, the start of it, or part of it), among `all`.
fn find<'a>(all: &'a [Activity], name: &str) -> Option<&'a Activity> {
    let n = name
        .trim()
        .trim_start_matches('#')
        .trim_matches(['“', '”', '"'])
        .to_lowercase();
    if n.is_empty() {
        return None;
    }
    let title = |a: &&Activity| a.title.to_lowercase();
    all.iter()
        .find(|a| title(a) == n)
        .or_else(|| all.iter().find(|a| title(a).starts_with(&n)))
        .or_else(|| all.iter().find(|a| title(a).contains(&n)))
}

/// Would `from` waiting for `to` close a loop (`to` waits, maybe through others, for `from`)?
fn would_loop(waits: &HashMap<String, String>, from: &str, to: &str) -> bool {
    let mut at = to.to_string();
    for _ in 0..=waits.len() {
        if at == from {
            return true;
        }
        match waits.get(&at) {
            Some(next) => at = next.clone(),
            None => return false,
        }
    }
    true
}

/// wait_for_tab: wait (up to `secs`) till the tab named `name` is done, then what it did.
pub fn wait(
    app: &AppHandle,
    id: &str,
    tab: &str,
    name: &str,
    secs: Option<u64>,
) -> Result<String, Error> {
    let all = activities(app, id, tab);
    let Some(other) = find(&all, name).cloned() else {
        let names: Vec<String> = all.iter().map(|a| format!("“{}”", a.title)).collect();
        return Err(if names.is_empty() {
            "You have no other tabs open right now.".to_string()
        } else {
            format!(
                "No tab called “{name}”. Your other tabs: {}.",
                names.join(", ")
            )
        }
        .into());
    };
    let (me, them) = (key_of(id, tab), key_of(id, &other.tab_id));
    if other.busy {
        {
            let mut waits = WAITS.locked();
            if would_loop(&waits, &me, &them) {
                return Err(format!("“{}” is waiting for you: don't wait for it, carry on (it goes on once you're done).", other.title).into());
            }
            waits.insert(me.clone(), them.clone());
        }
        let busy = |key: &str| {
            with(app, |st| {
                st.chats.get(key).is_some_and(|c| c.session.busy())
            })
        };
        let until = std::time::Instant::now()
            + Duration::from_secs(secs.unwrap_or(WAIT_DEFAULT).clamp(1, WAIT_MAX));
        // (till it's done, the wait is up, or this tab was stopped meanwhile)
        while busy(&them) && busy(&me) && std::time::Instant::now() < until {
            thread::sleep(POLL);
        }
        WAITS.locked().remove(&me);
        if busy(&them) {
            return Ok(format!(
                "“{}” is still working (on “{}”). Wait again, or carry on without it.",
                other.title, other.asked
            ));
        }
    }
    let after = activities(app, id, tab)
        .into_iter()
        .find(|a| a.tab_id == other.tab_id)
        .unwrap_or(other.clone());
    Ok(done_text(app, id, &after, other.busy))
}

/// What the tab waited for did: its last answer, and the files it changed.
fn done_text(app: &AppHandle, id: &str, a: &Activity, waited: bool) -> String {
    let answer = with(app, |st| {
        let t = st.store.tab(id, &a.tab_id)?;
        let h = t["history"]
            .as_array()?
            .iter()
            .rev()
            .find(|h| h["role"] == "assistant")?;
        Some(h["text"].as_str().unwrap_or("").to_string())
    })
    .unwrap_or_default();
    let folder = folder_of(app, id);
    let files = shown_files(&a.files, &folder);
    let mut out = if waited {
        format!("“{}” is done (it was working on “{}”).", a.title, a.asked)
    } else {
        format!("“{}” isn't working on anything right now.", a.title)
    };
    if !files.is_empty() {
        out += &format!(
            " It changed: {}. Read them again before changing them.",
            files.join(", ")
        );
    }
    let answer = answer.trim();
    if !answer.is_empty() {
        out += &format!("\n\nIts last answer:\n{}", cut(answer, ANSWER_MAX));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn act(title: &str, busy: bool, files: &[&str]) -> Activity {
        Activity {
            tab_id: title.to_lowercase(),
            title: title.into(),
            busy,
            asked: "fix the login".into(),
            doing: "Edit: src/auth.rs".into(),
            files: files.iter().map(|f| f.to_string()).collect(),
        }
    }

    #[test]
    fn a_turn_keeps_the_files_it_changes() {
        let mut now = Now::asked("\n  fix the login\nplease");
        now.saw(
            "Read",
            "src/a.rs",
            &json!({ "file_path": "C:\\p\\src\\a.rs" }),
        );
        now.saw(
            "Edit",
            "src/auth.rs",
            &json!({ "file_path": "C:\\p\\src\\auth.rs" }),
        );
        now.saw(
            "Edit",
            "src/auth.rs",
            &json!({ "file_path": "C:\\p\\src\\auth.rs" }),
        );
        now.saw(
            "NotebookEdit",
            "",
            &json!({ "notebook_path": "C:\\p\\n.ipynb" }),
        );
        assert_eq!(now.asked, "fix the login");
        assert_eq!(now.doing, "NotebookEdit");
        assert_eq!(now.files, ["C:\\p\\src\\auth.rs", "C:\\p\\n.ipynb"]);
    }

    #[test]
    fn the_same_file_is_guarded_however_it_is_named() {
        let busy = [act("Auth", true, &["C:\\proj\\src\\auth.rs"])];
        let why = guard_for(&busy, "C:\\proj", "c:/proj/src/../src/Auth.rs").expect("guarded");
        assert!(
            why.starts_with("Your other tab “Auth” is changing src/Auth.rs right now"),
            "{why}"
        );
        assert!(why.contains("wait_for_tab with tab “Auth”"), "{why}");
        assert_eq!(
            guard_for(&busy, "C:\\proj", "C:\\proj\\src\\other.rs"),
            None
        );
        assert_eq!(guard_for(&busy, "C:\\proj", ""), None);
    }

    #[test]
    fn the_meanwhile_note_names_who_is_at_work_on_what() {
        assert_eq!(meanwhile_note(&[], "C:\\proj"), "");
        let note = meanwhile_note(
            &[act("Auth", true, &["C:\\proj\\src\\auth.rs"])],
            "C:\\proj",
        );
        assert_eq!(
            note,
            "\n\n[Meanwhile, other tabs of yours are working in this same folder:\n- “Auth”: working on “fix the login”; now Edit: src/auth.rs; changing src/auth.rs\nDon't change a file one of them is changing: wait for it with wait_for_tab (then read the file again), or do the rest first.]"
        );
        assert_eq!(
            line_for(
                &act("Docs", false, &["C:\\proj\\README.md", "README.md"]),
                "C:\\proj"
            ),
            "- “Docs”: idle (last asked “fix the login”; changed README.md)"
        );
    }

    #[test]
    fn tabs_are_found_by_name_its_start_or_part_of_it() {
        let all = [act("Auth refactor", true, &[]), act("Tests", false, &[])];
        assert_eq!(
            find(&all, "#\"auth refactor\"").map(|a| a.title.as_str()),
            Some("Auth refactor")
        );
        assert_eq!(find(&all, "tes").map(|a| a.title.as_str()), Some("Tests"));
        assert_eq!(
            find(&all, "factor").map(|a| a.title.as_str()),
            Some("Auth refactor")
        );
        assert_eq!(find(&all, "docs"), None);
        assert_eq!(find(&all, " "), None);
    }

    #[test]
    fn two_tabs_never_wait_for_each_other() {
        let mut waits = HashMap::new();
        assert!(!would_loop(&waits, "a", "b"));
        waits.insert("b".to_string(), "c".to_string());
        waits.insert("c".to_string(), "a".to_string());
        assert!(would_loop(&waits, "a", "b"));
        assert!(!would_loop(&waits, "d", "b"));
        assert!(would_loop(&waits, "a", "a"));
    }
}
