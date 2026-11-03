//! A robot's tabs talking to each other (mcp/tools/tabs.rs): one asks another something and
//! waits for the answer (ask_tab), tells it something and carries on (tell_tab), or opens a new
//! tab for a job (open_tab). The message is asked in the other tab as a question of its own,
//! tagged with the tab it's from (the page shows it so: tab-message), and answered there like
//! any other; an ask's answer goes back when that turn is over. A tab another one opened joins
//! its group (the strip folds a group into one chip: gui/features/chat/tabs/groups.ts).
//! Guards: no asking a tab that is waiting on you, even through others (tabs.rs's WAITS, which
//! wait_for_tab keeps too); no answer within ANSWER_WAIT, the tab asked closing or the tab
//! asking being stopped all end the wait.

use std::sync::LazyLock;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::time::Instant;

use super::tabs::{self, Activity, WAITS};
use super::*;
use crate::runtime::Error;
use crate::store::{self, Store};

const ANSWER_WAIT: Duration = Duration::from_secs(10 * 60);
const POLL: Duration = Duration::from_millis(400);
const ANSWER_MAX: usize = 8000; // (characters of the answer told to the tab that asked)
const TITLE_MAX: usize = 40;

/// An answer, or why there is none.
type Answer = Result<String, String>;

/// The asks waiting for their answer: the turn asked (robot|tab|turn) -> the tab waiting.
static ASKS: LazyLock<Mutex<HashMap<String, Sender<Answer>>>> = LazyLock::new(Mutex::default);

/// What a message to another tab is, as that tab reads it.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Say {
    Ask,  // it waits for the answer
    Tell, // it doesn't
    Open, // a job, in a tab opened for it
}

fn ask_key(id: &str, tab_id: &str, turn_id: &str) -> String {
    format!("{}|{turn_id}", key_of(id, tab_id))
}

// ---------------------------------------------------------------- the answers

/// A turn in a tab is over (its answer, or why there is none): to the tab that asked it, if one
/// did.
pub fn answered(id: &str, tab_id: &str, turn_id: &str, answer: Answer) {
    if let Some(tx) = ASKS.locked().remove(&ask_key(id, tab_id, turn_id)) {
        let _ = tx.send(answer); // (gone: it stopped waiting)
    }
}

/// Questions waiting their turn in a tab, dropped (it was stopped): the tabs that asked them
/// hear so.
pub fn dropped(id: &str, tab_id: &str, turn_ids: &[String]) {
    for t in turn_ids {
        answered(
            id,
            tab_id,
            t,
            Err("it was stopped before it got to it".into()),
        );
    }
}

// ---------------------------------------------------------------- ask_tab, tell_tab

/// ask_tab: `tab` asks the tab called `name`, and waits for its answer.
pub fn ask_tab(
    app: &AppHandle,
    id: &str,
    tab: &str,
    name: &str,
    message: &str,
) -> Result<String, Error> {
    let to = target(app, id, tab, name)?;
    let message = said(message, "The message is empty.")?;
    let (me, them) = (key_of(id, tab), key_of(id, &to.tab_id));
    {
        let mut waits = WAITS.locked();
        if tabs::would_loop(&waits, &me, &them) {
            return Err(format!(
                "“{}” is waiting on you (it asked you this, maybe through another tab), so don't ask it back: put what you need to know in your answer instead.",
                to.title
            )
            .into());
        }
        waits.insert(me.clone(), them);
    }
    let turn = uuid::Uuid::new_v4().to_string();
    let key = ask_key(id, &to.tab_id, &turn);
    let (tx, rx) = mpsc::channel();
    ASKS.locked().insert(key.clone(), tx); // (before it's asked: the answer may be quick)
    let got = deliver(app, id, tab, &to.tab_id, &message, Say::Ask, &turn)
        .and_then(|_| wait_answer(app, id, tab, &to, &rx));
    ASKS.locked().remove(&key);
    WAITS.locked().remove(&me);
    let answer = got?;
    let answer = answer.trim();
    Ok(format!(
        "“{}” says:\n{}",
        to.title,
        if answer.is_empty() {
            "(an empty answer)".to_string()
        } else {
            cut(answer, ANSWER_MAX)
        }
    ))
}

/// tell_tab: `tab` tells the tab called `name` something, and carries on.
pub fn tell_tab(
    app: &AppHandle,
    id: &str,
    tab: &str,
    name: &str,
    message: &str,
) -> Result<String, Error> {
    let to = target(app, id, tab, name)?;
    let message = said(message, "The message is empty.")?;
    let turn = uuid::Uuid::new_v4().to_string();
    let queued = deliver(app, id, tab, &to.tab_id, &message, Say::Tell, &turn)?;
    Ok(if queued {
        format!(
            "Sent to “{}”. It's busy, so it reads it once it's done with what it's on.",
            to.title
        )
    } else {
        format!("Sent to “{}”: it's reading it now.", to.title)
    })
}

/// The answer, as long as it takes (up to ANSWER_WAIT); an error if it never comes, the tab
/// asked closes, or the tab asking is stopped meanwhile.
fn wait_answer(
    app: &AppHandle,
    id: &str,
    tab: &str,
    to: &Activity,
    rx: &Receiver<Answer>,
) -> Result<String, Error> {
    let until = Instant::now() + ANSWER_WAIT;
    loop {
        match rx.recv_timeout(POLL) {
            Ok(Ok(text)) => return Ok(text),
            Ok(Err(why)) => {
                return Err(format!("“{}” couldn't answer: {why}", to.title).into());
            }
            Err(RecvTimeoutError::Disconnected) => return Err("Cancelled.".into()),
            Err(RecvTimeoutError::Timeout) => {}
        }
        let (asking, there) = with(app, |st| {
            (is_busy(st, id, tab), st.store.tab(id, &to.tab_id).is_some())
        });
        if !asking {
            return Err("Cancelled.".into());
        }
        if !there {
            return Err(format!("“{}” was closed before it answered.", to.title).into());
        }
        if Instant::now() >= until {
            return Err(format!(
                "No answer from “{}” after {} minutes (it may be waiting on the user in its tab). Carry on without it, or wait for it with mcp__cbot__wait_for_tab.",
                to.title,
                ANSWER_WAIT.as_secs() / 60
            )
            .into());
        }
    }
}

// ---------------------------------------------------------------- open_tab

/// open_tab: `tab` opens a new tab called `title` for `task`, in its group, and carries on (it
/// gets the new tab's report with wait_for_tab).
pub fn open_tab(
    app: &AppHandle,
    id: &str,
    tab: &str,
    title: &str,
    task: &str,
) -> Result<String, Error> {
    let title = clean_title(title);
    if title.is_empty() {
        return Err("The new tab needs a short title.".into());
    }
    let task = said(task, "The new tab needs a task.")?;
    let new = with(app, |st| add_to_group(&mut st.store, id, tab, &title))?;
    crate::robots::send_character(app, id); // (the page makes the tab before its task goes in)
    let turn = uuid::Uuid::new_v4().to_string();
    deliver(app, id, tab, &new, &task, Say::Open, &turn)?;
    Ok(format!(
        "Opened the tab “{title}”: it's working on it now. When you need its report, wait for it with mcp__cbot__wait_for_tab (tab “{title}”); to talk to it meanwhile, use mcp__cbot__ask_tab or mcp__cbot__tell_tab."
    ))
}

/// The new tab, in `tab`'s group (a new group if it has none), right after the group's last
/// tab; the tab you're in stays the one shown. Its id.
fn add_to_group(store: &mut Store, id: &str, tab: &str, title: &str) -> Result<String, Error> {
    let Some(me) = store.tab(id, tab).cloned() else {
        return Err("This conversation is gone.".into());
    };
    let group = me["group"]
        .as_str()
        .filter(|g| !g.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("g-{}", uuid::Uuid::new_v4().simple()));
    let shown = store
        .get(id)
        .map_or(Value::Null, |c| c["activeTab"].clone());
    let fields = patch(vec![("title", json!(title)), ("group", json!(group))]);
    let Some(new) = store.add_tab(id, fields) else {
        return Err("There's no room for another tab (8 at most): close one, or ask one that's idle with mcp__cbot__ask_tab.".into());
    };
    let new_id = new.id().to_string();
    store.update_tab(id, tab, patch(vec![("group", json!(group))]));
    let at = store
        .get(id)
        .and_then(|c| c["tabs"].as_array())
        .and_then(|tabs| spot(tabs, &group, &new_id));
    if let Some(at) = at {
        store.move_tab(id, &new_id, at);
    }
    store.update(id, patch(vec![("activeTab", shown)]));
    Ok(new_id)
}

/// Where a group's new tab goes in the strip: after the group's last other tab.
fn spot(tabs: &[Value], group: &str, new_id: &str) -> Option<usize> {
    tabs.iter()
        .rposition(|t| t["group"] == group && t.id() != new_id)
        .map(|i| i + 1)
}

fn clean_title(title: &str) -> String {
    title
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(TITLE_MAX)
        .collect()
}

// ---------------------------------------------------------------- the message

/// The tab called `name` (its title, the start of it, or part of it), among this robot's others.
fn target(app: &AppHandle, id: &str, tab: &str, name: &str) -> Result<Activity, Error> {
    let all = tabs::activities(app, id, tab);
    if let Some(a) = tabs::find(&all, name) {
        return Ok(a.clone());
    }
    let names: Vec<String> = all.iter().map(|a| format!("“{}”", a.title)).collect();
    Err(if names.is_empty() {
        "You have no other tabs open right now: open one for the job with mcp__cbot__open_tab."
            .to_string()
    } else {
        format!(
            "No tab called “{name}”. Your other tabs: {}.",
            names.join(", ")
        )
    }
    .into())
}

fn said(message: &str, empty: &str) -> Result<String, Error> {
    let m = message.trim();
    if m.is_empty() {
        Err(empty.into())
    } else {
        Ok(m.to_string())
    }
}

/// The message into tab `to`, as a question of its own tagged with the tab it's from: started
/// now, or after what it's on (whether it waits its turn). The page hears of it first: its turn
/// may start straight away, inside ask.
fn deliver(
    app: &AppHandle,
    id: &str,
    from: &str,
    to: &str,
    message: &str,
    say: Say,
    turn: &str,
) -> Result<bool, Error> {
    let (from_title, to_title, queued) = with(app, |st| {
        let title = |t: &str| st.store.tab(id, t).map(store::title_for);
        (
            title(from).unwrap_or_else(|| "another tab".into()),
            title(to).unwrap_or_default(),
            is_busy(st, id, to),
        )
    });
    let tag = format!("↳ From “{from_title}”");
    tell(
        app,
        id,
        to,
        PageEvent::TabMessage {
            text: message.into(),
            tag: tag.clone(),
            from_tab: from.into(),
            turn_id: turn.into(),
            queued,
        },
    );
    let note = note_for(say, &from_title);
    let res = ask(
        app,
        id,
        to,
        Ask {
            prompt: message,
            attachments: &[],
            turn_id: Some(turn.into()),
            kind: AskKind::Chat,
            tag: Some(&tag),
            briefs: &[],
            note: Some(&note),
        },
    );
    if res["ok"] == true {
        return Ok(queued);
    }
    let turn_ids = vec![turn.to_string()];
    tell(app, id, to, PageEvent::Dropped { turn_ids }); // (its bubble: not sent)
    Err(format!(
        "“{to_title}” can't take it: {}",
        res["error"].as_str().unwrap_or("it isn't ready")
    )
    .into())
}

/// What the tab reads after the message, for it alone: who it's from, and what to do about it.
fn note_for(say: Say, from: &str) -> String {
    let who = format!(
        "“{from}”, another tab of yours (a conversation of yours in this same folder, not the user)"
    );
    let what = match say {
        Say::Ask => format!(
            "This message is from {who}. It's waiting for your reply: your answer goes back to it as it is, so answer it directly and to the point, with what it needs."
        ),
        Say::Tell => format!(
            "This message is from {who}. It isn't waiting for a reply: take it into account and carry on. To answer it anyway, use mcp__cbot__tell_tab or mcp__cbot__ask_tab with tab “{from}”."
        ),
        Say::Open => format!(
            "{who} opened this tab for this job: do it here. When you're done, end with a short report for it: what you did, the files you changed, and anything it needs to know or check (it gets your report with mcp__cbot__wait_for_tab). Other tabs may be at work in the folder too: keep to your job's files."
        ),
    };
    format!("\n\n[{what}]")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_groups_new_tab_goes_after_its_last() {
        let tabs = [
            json!({ "id": "a", "group": "g" }),
            json!({ "id": "b" }),
            json!({ "id": "c", "group": "g" }),
            json!({ "id": "d" }),
            json!({ "id": "new", "group": "g" }),
        ];
        assert_eq!(spot(&tabs, "g", "new"), Some(3));
        assert_eq!(spot(&tabs, "h", "new"), None);
    }

    #[test]
    fn a_new_tabs_title_is_one_short_line() {
        assert_eq!(clean_title("  Migrate\n the   DB "), "Migrate the DB");
        assert_eq!(clean_title(&"x".repeat(60)).chars().count(), TITLE_MAX);
        assert_eq!(clean_title(" \n "), "");
    }

    #[test]
    fn the_tab_reads_who_its_from_and_what_to_do() {
        let ask = note_for(Say::Ask, "Types");
        assert!(ask.starts_with("\n\n[This message is from “Types”, another tab of yours"));
        assert!(ask.contains("It's waiting for your reply") && ask.ends_with(']'));
        let tell = note_for(Say::Tell, "Types");
        assert!(
            tell.contains("isn't waiting") && tell.contains("mcp__cbot__ask_tab with tab “Types”")
        );
        let open = note_for(Say::Open, "Types");
        assert!(
            open.starts_with("\n\n[“Types”, another tab of yours")
                && open.contains("mcp__cbot__wait_for_tab")
        );
    }

    #[test]
    fn an_answer_goes_to_the_tab_waiting_for_that_turn_only() {
        let (tx, rx) = mpsc::channel();
        ASKS.locked().insert(ask_key("r", "b", "t1"), tx);
        answered("r", "b", "t2", Ok("not this one".into()));
        assert!(rx.try_recv().is_err());
        dropped("r", "b", &["t1".to_string()]);
        assert_eq!(
            rx.try_recv(),
            Ok(Err("it was stopped before it got to it".into()))
        );
        assert!(!ASKS.locked().contains_key(&ask_key("r", "b", "t1")));
    }
}
