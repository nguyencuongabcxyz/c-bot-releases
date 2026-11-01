//! The people in a shared chat talking among themselves: what a guest says, comments or
//! recommends goes to the host's page and to every guest (the sender too, so all see it in
//! the same order); what the host says goes to every guest. And the plans and questions
//! waiting for the host, which guests see and weigh in on (the host still decides).

use std::time::{Duration, Instant};

use super::*;
use crate::features::share::people::{self, CHOICE_MAX, PER_MINUTE, QUOTE_MAX, TALK_MAX, WHY_MAX};

fn send_all(outs: &[Out], m: &Msg) {
    let line = m.line();
    for tx in outs {
        let _ = tx.send(line.clone());
    }
}

/// Something a guest said to the people in the chat (a Talk, a Comment or a Recommend).
pub(super) fn from_guest(app: &AppHandle, conn: u64, m: Msg) {
    let Some((robot, tab, from, outs, waiting)) = shares(app, |s| {
        let h = s.host.as_mut()?;
        let waiting: Vec<String> = h
            .decisions
            .iter()
            .filter_map(|d| d["requestId"].as_str().map(str::to_string))
            .collect();
        let outs = h.senders();
        let g = h.guests.iter_mut().find(|g| g.conn == conn && g.admitted)?;
        g.said.retain(|t| t.elapsed() < Duration::from_secs(60));
        if g.said.len() >= PER_MINUTE {
            return None; // (too much at once: dropped)
        }
        g.said.push(Instant::now());
        Some((
            h.robot.clone(),
            h.tab.clone(),
            g.person.clone(),
            outs,
            waiting,
        ))
    }) else {
        return;
    };
    let (out, ev) = match m {
        Msg::Talk { text } => {
            let Some(text) = people::said(&text, TALK_MAX) else {
                return;
            };
            (
                Msg::Talked {
                    from: from.clone(),
                    text: text.clone(),
                },
                PageEvent::ShareTalk {
                    from,
                    text,
                    mine: false,
                },
            )
        }
        Msg::Comment { quote, text } => {
            let (Some(quote), Some(text)) = (
                people::said(&quote, QUOTE_MAX),
                people::said(&text, TALK_MAX),
            ) else {
                return;
            };
            let found = in_the_chat(app, &robot, &tab, &quote);
            (
                Msg::Commented {
                    from: from.clone(),
                    quote: quote.clone(),
                    text: text.clone(),
                    found,
                },
                PageEvent::ShareComment {
                    from,
                    quote,
                    text,
                    found,
                },
            )
        }
        Msg::Recommend {
            request_id,
            choice,
            why,
        } => {
            let Some(choice) =
                people::said(&choice, CHOICE_MAX).filter(|_| waiting.contains(&request_id))
            else {
                return; // (nothing waits for that any more)
            };
            let why = people::maybe(&why, WHY_MAX);
            (
                Msg::Recommended {
                    from: from.clone(),
                    request_id: request_id.clone(),
                    choice: choice.clone(),
                    why: why.clone(),
                },
                PageEvent::ShareRecommend {
                    request_id,
                    from,
                    choice,
                    why,
                },
            )
        }
        _ => return,
    };
    send_all(&outs, &out);
    tell(app, &robot, &tab, ev);
}

/// Is what a guest quoted really in the shared tab (its messages and answers so far)?
fn in_the_chat(app: &AppHandle, robot: &str, tab: &str, quote: &str) -> bool {
    let texts: Vec<String> = with(app, |st| {
        st.store
            .tab(robot, tab)
            .and_then(|t| t["history"].as_array().cloned())
            .unwrap_or_default()
    })
    .iter()
    .filter_map(|h| h["text"].as_str().map(str::to_string))
    .collect();
    people::quote_in(texts.iter().map(String::as_str), quote)
}

/// The host saying something to the people in the chat.
pub(in crate::features::share) fn host_talk(
    app: &AppHandle,
    robot: &str,
    text: &str,
) -> Result<(), Error> {
    let text = people::said(text, TALK_MAX).ok_or_else(|| Error::from("Say something first."))?;
    let (tab, from, outs) = shares(app, |s| {
        let h = s.host.as_ref().filter(|h| h.robot == robot)?;
        Some((h.tab.clone(), h.view().host, h.senders()))
    })
    .ok_or_else(|| Error::from("Sharing has stopped."))?;
    send_all(
        &outs,
        &Msg::Talked {
            from: from.clone(),
            text: text.clone(),
        },
    );
    tell(
        app,
        robot,
        &tab,
        PageEvent::ShareTalk {
            from,
            text,
            mine: true,
        },
    );
    Ok(())
}

// ---------------------------------------------------------------- decisions

/// A plan or a question now waits for the host: the guests see it.
pub(in crate::features::share) fn decision(app: &AppHandle, ev: &Value) {
    let Some(d) = people::decision_for_guests(ev) else {
        return;
    };
    let Some(outs) = shares(app, |s| {
        let h = s.host.as_mut()?;
        h.decisions.retain(|x| x["requestId"] != d["requestId"]);
        h.decisions.push(d.clone());
        Some(h.senders())
    }) else {
        return;
    };
    send_all(&outs, &Msg::Decision { decision: d });
}

/// What became of one (answered, approved, sent back, cancelled): the guests hear.
pub(in crate::features::share) fn decided(app: &AppHandle, request_id: &str, outcome: &str) {
    let Some(outs) = shares(app, |s| {
        let h = s.host.as_mut()?;
        let before = h.decisions.len();
        h.decisions.retain(|x| x["requestId"] != request_id);
        (h.decisions.len() < before).then(|| h.senders())
    }) else {
        return;
    };
    send_all(
        &outs,
        &Msg::Decided {
            request_id: request_id.into(),
            outcome: people::maybe(outcome, CHOICE_MAX),
        },
    );
}

/// The answer is over: whatever still waited doesn't any more.
pub(in crate::features::share) fn all_decided(app: &AppHandle) {
    let ids: Vec<String> = shares(app, |s| {
        s.host
            .as_ref()
            .map(|h| {
                h.decisions
                    .iter()
                    .filter_map(|d| d["requestId"].as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    });
    for id in ids {
        decided(app, &id, "no longer waiting");
    }
}

/// What waits for the host now (for a guest just let in).
pub(super) fn waiting(app: &AppHandle) -> Vec<Value> {
    shares(app, |s| {
        s.host
            .as_ref()
            .map(|h| h.decisions.clone())
            .unwrap_or_default()
    })
}
