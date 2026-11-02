//! How the code tools are used, for the Context optimizer window's Tools: each tool's calls,
//! failures, time and how much it answered, so what's worth its place among the tools (and what
//! every conversation pays to be told about) shows. Kept on this computer only, in
//! <dir>/usage.json; deleting everything the optimizer keeps deletes it too.

use super::*;

/// One tool's use, all its calls together.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolUse {
    pub tool: String,
    pub calls: u64,
    pub errors: u64,
    pub ms: u64,    // (all its calls' time)
    pub chars: u64, // (all its answers' length)
    pub last: u64,  // (its last call, ms since 1970)
}

/// Saves in the order they're counted (two calls ending together don't swap their files).
static SAVING: Mutex<()> = Mutex::new(());

/// A call of `tool` counted: how long it took, how long its answer was, whether it failed.
pub fn record_use(app: &AppHandle, tool: &str, took: Duration, chars: usize, ok: bool) {
    let _turn = SAVING.locked();
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX));
    let ms = u64::try_from(took.as_millis()).unwrap_or(u64::MAX);
    let (dir, all) = engine(app, |e| {
        let list = e.usage.get_or_insert_with(|| load(&e.dir));
        count(list, tool, ms, chars as u64, ok, now);
        (e.dir.clone(), list.clone())
    });
    save(&dir, &all);
}

/// Every tool's use so far, the most called first.
pub(super) fn uses(app: &AppHandle) -> Vec<ToolUse> {
    let mut all = engine(app, |e| e.usage.get_or_insert_with(|| load(&e.dir)).clone());
    all.sort_by(|a, b| b.calls.cmp(&a.calls).then_with(|| a.tool.cmp(&b.tool)));
    all
}

/// A call added to its tool's counts.
fn count(list: &mut Vec<ToolUse>, tool: &str, ms: u64, chars: u64, ok: bool, now: u64) {
    let at = list.iter().position(|u| u.tool == tool).unwrap_or_else(|| {
        list.push(ToolUse {
            tool: tool.to_string(),
            ..ToolUse::default()
        });
        list.len() - 1
    });
    let u = &mut list[at];
    u.calls += 1;
    u.errors += u64::from(!ok);
    u.ms = u.ms.saturating_add(ms);
    u.chars = u.chars.saturating_add(chars);
    u.last = now;
}

fn file(dir: &Path) -> PathBuf {
    dir.join("usage.json")
}

fn load(dir: &Path) -> Vec<ToolUse> {
    std::fs::read_to_string(file(dir))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

/// Written whole, through a file beside it swapped in (a half-written one is never read).
fn save(dir: &Path, all: &[ToolUse]) {
    let Ok(text) = serde_json::to_string_pretty(all) else {
        return;
    };
    let temp = dir.join("usage.json.tmp");
    let saved = std::fs::create_dir_all(dir)
        .and_then(|()| std::fs::write(&temp, text))
        .and_then(|()| std::fs::rename(&temp, file(dir)));
    if let Err(e) = saved {
        log::warn!("Couldn't save the tools' use in {}: {e}", dir.display());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_call_adds_to_its_tools_counts() {
        let mut list = vec![];
        count(&mut list, "find_symbol", 40, 300, true, 1);
        count(&mut list, "find_symbol", 60, 500, false, 2);
        count(&mut list, "code_map", 10, 8_000, true, 3);
        assert_eq!(
            list[0],
            ToolUse {
                tool: "find_symbol".into(),
                calls: 2,
                errors: 1,
                ms: 100,
                chars: 800,
                last: 2,
            }
        );
        assert_eq!(list[1].calls, 1);
    }

    #[test]
    fn its_use_is_kept_in_a_file_and_read_back() {
        let dir =
            std::env::temp_dir().join(format!("cbot-ctx-usage-{}", uuid::Uuid::new_v4().simple()));
        let mut list = vec![];
        count(&mut list, "explain_symbol", 25, 1_200, true, 9);
        save(&dir, &list);
        let back = load(&dir);
        let json = std::fs::read_to_string(file(&dir)).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(back, list);
        assert!(json.contains("\"tool\": \"explain_symbol\""), "{json}");
        assert!(load(Path::new("no such folder")).is_empty());
    }
}
