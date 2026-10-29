//! Past conversations thrown away (the bin in "Past chats"): their transcripts, and the
//! closed tabs that could have brought them back.

use super::*;
use std::collections::HashSet;

use crate::runtime::Error;
use crate::store::Fields;

/// Throw past conversations away: these, or (none named) every one the robot had. Ones open
/// in a tab stay. How many went.
pub fn forget_sessions(
    app: &AppHandle,
    id: &str,
    session_ids: Option<Vec<String>>,
) -> Result<usize, Error> {
    let Some(c) = with(app, |st| st.store.get(id).cloned()) else {
        return Err("Unknown robot".into());
    };
    let folder = c.folder().to_string();
    if folder.is_empty() {
        return Ok(0);
    }
    let open: HashSet<String> = c["tabs"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|t| [sessions_of(t), side::sessions_of(t)].concat())
        .collect();
    let gone: Vec<String> = session_ids
        .unwrap_or_else(|| all_of(&c))
        .into_iter()
        .filter(|s| !open.contains(s))
        .collect();
    let mut n = 0;
    for s in &gone {
        n += usize::from(transcripts::forget(&folder, s));
    }
    // (the side questions of the closed tabs that went: nothing could open them now)
    let dropped = with(app, |st| st.store.forget_sessions(id, &gone));
    for s in dropped.iter().flat_map(side::sessions_of) {
        transcripts::forget(&folder, &s);
    }
    Ok(n)
}

/// Every conversation the robot had: the ones it started, and its closed tabs'.
fn all_of(c: &Value) -> Vec<String> {
    let closed = c["closedTabs"].as_array().into_iter().flatten();
    c["sessionIds"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .chain(closed.filter_map(|t| t.session_id()))
        .map(str::to_string)
        .collect()
}
