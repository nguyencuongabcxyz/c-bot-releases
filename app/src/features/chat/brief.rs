//! Briefs (@#tab in a message): what another of the robot's conversations knows, for the one
//! you're writing in. A throwaway branch of that tab writes it (--fork-session, like a side
//! question: it knows everything said there, works while that tab is answering, and the tab
//! never hears about it). The brief goes with your message, shown under it.

use std::sync::mpsc;

use serde::{Deserialize, Serialize};

use super::*;
use crate::agents::Event;
use crate::runtime::Error;
use crate::store;

const WAIT: Duration = Duration::from_secs(180);
const BRIEF_MAX: usize = 6000; // (characters)
const BRIEFS_MAX: usize = 3; // (per message)
const NOTE: &str = "This is a brief for another of your conversations with the user (another chat tab, in this same folder): they mentioned this conversation there, so it needs what you know here. Write only the brief. You may look at files, but change nothing.";

/// A brief that goes with a message: the tab it came from, and what that tab wrote.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Brief {
    pub title: String,
    pub text: String,
}

/// Ask tab `from` for a brief for tab `to`, where you're writing `draft`. Waits for it.
pub fn brief(
    app: &AppHandle,
    id: &str,
    from: &str,
    to: &str,
    draft: &str,
) -> Result<String, Error> {
    let (c, tab, to_title, settings) = with(app, |st| {
        Some((
            st.store.get(id)?.clone(),
            st.store.tab(id, from)?.clone(),
            store::title_for(st.store.tab(id, to)?),
            st.store.settings().clone(),
        ))
    })
    .ok_or("That conversation is gone.")?;
    let title = store::title_for(&tab);
    if tab["temporary"] == true {
        return Err("A temporary chat keeps what it knows to itself.".into());
    }
    let Some(main) = tab.session_id().map(str::to_string) else {
        return Err(format!("“{title}” hasn't talked about anything yet.").into());
    };
    let folder = c.folder();
    if folder.is_empty() || !Path::new(folder).exists() {
        return Err("My folder is missing. Point me at a new one in the Robot Workshop.".into());
    }
    let claude_path = locate::find(settings["claudePath"].as_str().unwrap_or(""))
        .ok_or("I can't find Claude Code anywhere on this computer.")?;
    let opts = claude::Opts {
        resume_at: side::branch_point(app, id, from, &tab),
        fork: true,
        ..side::looking(app, &c, &tab, claude_path, NOTE)
    };
    let (tx, rx) = mpsc::channel::<Result<String, String>>();
    let tx = Mutex::new(tx);
    let handler: claude::Handler = Arc::new(move |_, event| {
        let got = match event {
            Event::Done(d) if d.is_error => Err(d.text),
            Event::Done(d) => Ok(d.text),
            Event::Fail(f) if f.session_missing => {
                Err("I can't find that conversation anymore.".into())
            }
            Event::Fail(f) => Err(f.message),
            _ => return,
        };
        let _ = tx.locked().send(got);
    });
    let session = Session::new(opts, Some(main.clone()), handler);
    session.ask(ask_for(&to_title, draft), uuid::Uuid::new_v4().to_string());
    let got = rx.recv_timeout(WAIT);
    session.close();
    // (the branch's own transcript goes; never the tab's, should it not have branched yet)
    let branch: Vec<String> = session
        .session_id()
        .filter(|s| *s != main)
        .into_iter()
        .collect();
    side::forget(app, id, branch);
    let text = match got {
        Ok(Ok(text)) => text,
        Ok(Err(why)) => return Err(why.into()),
        Err(_) => return Err(format!("“{title}” took too long to write its brief.").into()),
    };
    let text: String = text.trim().chars().take(BRIEF_MAX).collect();
    if text.is_empty() {
        return Err(format!("“{title}” had nothing to say.").into());
    }
    Ok(text)
}

/// What the branch is asked: a brief for the tab you're writing in.
fn ask_for(to_title: &str, draft: &str) -> String {
    let draft = draft.trim();
    let so_far = if draft.is_empty() {
        String::new()
    } else {
        let quoted: Vec<String> = draft.lines().map(|l| format!("> {l}")).collect();
        format!(
            ", in this message (still being written):\n{}\n\n",
            quoted.join("\n")
        )
    };
    let to = if to_title.is_empty() {
        "another chat"
    } else {
        to_title
    };
    format!(
        "The user is writing in your other conversation “{to}” and mentioned this one there{}{}Write a brief for it: what from this conversation it needs (decisions, facts, names, files changed, what's still open), or, if the message asks something about this conversation, the answer. Concrete and short (about 200 words at most), plain markdown, no greeting. If nothing here is relevant, say so in one line.",
        so_far,
        if so_far.is_empty() { ". " } else { "" },
    )
}

/// The question with the briefs that go with it (a few, each cut to size).
pub(super) fn with_briefs(prompt: &str, briefs: &[Brief]) -> String {
    let mut full = prompt.to_string();
    for b in briefs.iter().take(BRIEFS_MAX) {
        let text: String = b.text.trim().chars().take(BRIEF_MAX).collect();
        let quoted: Vec<String> = text.lines().map(|l| format!("> {l}")).collect();
        full += &format!(
            "\n\n[The user mentioned your other conversation “{}” with @#. A brief it wrote for this one:]\n{}",
            b.title.trim(),
            quoted.join("\n")
        );
    }
    full
}

/// The briefs as kept with the message in history (as many as went with it).
pub(super) fn kept(briefs: &[Brief]) -> Vec<Brief> {
    briefs
        .iter()
        .take(BRIEFS_MAX)
        .map(|b| Brief {
            title: b.title.trim().to_string(),
            text: b.text.trim().chars().take(BRIEF_MAX).collect(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b(title: &str, text: &str) -> Brief {
        Brief {
            title: title.into(),
            text: text.into(),
        }
    }

    #[test]
    fn briefs_go_under_the_question_quoted() {
        let full = with_briefs(
            "write the tests",
            &[b("Auth", "JWT now.\nRefresh bug open.")],
        );
        assert_eq!(
            full,
            "write the tests\n\n[The user mentioned your other conversation “Auth” with @#. A brief it wrote for this one:]\n> JWT now.\n> Refresh bug open."
        );
        assert_eq!(with_briefs("hi", &[]), "hi");
    }

    #[test]
    fn only_a_few_briefs_go_and_each_is_cut() {
        let long = "x".repeat(BRIEF_MAX + 50);
        let many: Vec<Brief> = (0..5).map(|i| b(&format!("T{i}"), &long)).collect();
        let full = with_briefs("q", &many);
        assert_eq!(full.matches("[The user mentioned").count(), BRIEFS_MAX);
        let k = kept(&many);
        assert_eq!(k.len(), BRIEFS_MAX);
        assert_eq!(k[0].text.chars().count(), BRIEF_MAX);
    }

    #[test]
    fn the_branch_hears_the_message_so_far() {
        let p = ask_for("Tests", "use @#Auth\nfor login");
        assert!(p.starts_with("The user is writing in your other conversation “Tests” and mentioned this one there, in this message (still being written):\n> use @#Auth\n> for login\n\nWrite a brief"), "{p}");
        let p = ask_for("", "");
        assert!(
            p.contains("“another chat” and mentioned this one there. Write a brief"),
            "{p}"
        );
    }

    #[test]
    fn a_brief_keeps_its_json() {
        let v = serde_json::to_value(b("Auth", "JWT")).unwrap();
        assert_eq!(v, json!({ "title": "Auth", "text": "JWT" }));
    }
}
