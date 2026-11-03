//! What a robot's page hears about a tab's conversation (robot:event, with the tab's id): the
//! names and fields of gui/types/model.ts ChatEvent. What Claude Code reported whole (a diff,
//! a helper, a plan, the answer's end…) goes on as its object, its type added in front.

use serde::Serialize;
use serde_json::Value;

use super::AskKind;
use crate::agents::{
    AgentEvent, Compact, Diff, Done, Fail, Plan, Question, TaskChange, Tool, ToolOutput,
};
use crate::features::share::{Person, ShareView, Suggestion};

#[derive(Serialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub(in crate::features) enum PageEvent {
    TurnStart {
        turn_id: String,
        kind: Option<AskKind>,
    },
    Text {
        delta: String,
    },
    Aside {
        text: String,
    },
    Thinking,
    ThinkingText {
        id: String,
        delta: String,
    },
    Status {
        text: String,
    },
    Usage {
        output_tokens: u64,
    },
    Mode {
        mode: String,
    },
    Tool(Tool),
    ToolOutput(ToolOutput),
    ToolImages {
        id: String,
        images: Vec<Value>,
    },
    /// An MCP App in the chat: { id, input, result, and its view }.
    App(Value),
    AppResult {
        id: String,
        result: Value,
    },
    Edit(Diff),
    Agent(AgentEvent),
    Tasks {
        tasks: Vec<Value>,
        change: TaskChange,
    },
    Compact(Compact),
    Question(Question),
    RequestCancelled {
        request_id: String,
    },
    Plan(Plan),
    Context {
        context: Value,
    },
    /// The turn's end, with when it went into the history and what kind of question it was.
    Done {
        #[serde(flatten)]
        done: Done,
        at: Value,
        kind: Option<AskKind>,
    },
    Fail(Fail),
    /// Questions waiting their turn, dropped (the answer was stopped).
    Dropped {
        turn_ids: Vec<String>,
    },
    Remote {
        on: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        url: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    RemoteState {
        state: Value,
    },
    RemotePrompt {
        text: String,
        tag: String,
    },
    /// A message from another of the robot's tabs (features/chat/peers.rs), asked in this one as a
    /// question of its own: who it's from, and whether it waits its turn.
    TabMessage {
        text: String,
        tag: String,
        from_tab: String,
        turn_id: String,
        queued: bool,
    },
    /// A shared chat changed: who's in, who's asking, how long it has left (features/share).
    ShareState {
        state: ShareView,
    },
    /// For the host: a guest's suggestion, as raw text (what can't be seen shown as codes).
    ShareSuggest {
        id: String,
        from: Person,
        text: String,
        hidden: bool,
    },
    /// For the host: the guest took their suggestion back.
    ShareTakenBack {
        id: String,
    },
    /// For a guest: what became of their suggestion.
    ShareSuggestion {
        id: String,
        state: Suggestion,
        #[serde(skip_serializing_if = "String::is_empty")]
        why: String,
    },
    /// Someone in the shared chat said something to the people in it (mine: the host's own).
    ShareTalk {
        from: Person,
        text: String,
        mine: bool,
    },
    /// Someone commented on a piece of the chat (quoted).
    ShareComment {
        from: Person,
        quote: String,
        text: String,
        /// The quote is really in the chat (the host looked).
        found: bool,
    },
    /// Someone recommends what to do about a plan or a question waiting for the host.
    ShareRecommend {
        request_id: String,
        from: Person,
        choice: String,
        why: String,
    },
    /// For a guest: a plan or a question waiting for the host (only what it asks).
    ShareDecision {
        decision: Value,
    },
    /// For a guest: what the host did about it.
    ShareDecided {
        request_id: String,
        outcome: String,
    },
    /// For a guest: the visiting robot has walked in to its desk.
    ShareArrived,
    /// The shared chat ended, and why.
    ShareEnded {
        reason: String,
    },
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::agents::Tokens;

    #[test]
    fn the_page_gets_its_names_and_fields() {
        let page = |e: PageEvent| serde_json::to_value(e).unwrap();
        assert_eq!(
            page(PageEvent::TurnStart {
                turn_id: "t1".into(),
                kind: Some(AskKind::Bonk)
            }),
            json!({ "type": "turn-start", "turnId": "t1", "kind": "bonk" })
        );
        assert_eq!(page(PageEvent::Thinking), json!({ "type": "thinking" }));
        assert_eq!(
            page(PageEvent::Usage { output_tokens: 7 }),
            json!({ "type": "usage", "outputTokens": 7 })
        );
        assert_eq!(
            page(PageEvent::ToolOutput(ToolOutput {
                id: "a".into(),
                text: "ok".into(),
                media: json!([]),
                is_error: false
            })),
            json!({ "type": "tool-output", "id": "a", "text": "ok", "media": [], "isError": false })
        );
        let done = Done {
            turn_id: "t1".into(),
            text: "hi".into(),
            asides: vec![],
            is_error: false,
            interrupted: false,
            cost_usd: 0.5,
            denials: vec!["Bash".into()],
            session_id: Some("s1".into()),
            uuid: None,
            tokens: Some(Tokens {
                input: 2,
                output: 3,
                cache_read: 1500,
                cache_write: 40,
                calls: 2,
                context: 900,
            }),
            ms: json!(900),
        };
        assert_eq!(
            page(PageEvent::Done {
                done,
                at: json!(42),
                kind: Some(AskKind::Chat)
            }),
            json!({ "type": "done", "turnId": "t1", "text": "hi", "asides": [], "isError": false, "interrupted": false,
                "costUsd": 0.5, "denials": ["Bash"], "sessionId": "s1", "uuid": null,
                "tokens": { "input": 2, "output": 3, "cacheRead": 1500, "cacheWrite": 40, "calls": 2, "context": 900 }, "ms": 900, "at": 42, "kind": "chat" })
        );
        assert_eq!(
            page(PageEvent::RequestCancelled {
                request_id: "r".into()
            }),
            json!({ "type": "request-cancelled", "requestId": "r" })
        );
        assert_eq!(
            page(PageEvent::Tool(Tool {
                id: "t".into(),
                name: "Read".into(),
                detail: "a.txt".into(),
                args: json!({ "file_path": "a.txt" }),
                input: None
            })),
            json!({ "type": "tool", "id": "t", "name": "Read", "detail": "a.txt", "args": { "file_path": "a.txt" } })
        );
        assert_eq!(
            page(PageEvent::Dropped {
                turn_ids: vec!["t2".into()]
            }),
            json!({ "type": "dropped", "turnIds": ["t2"] })
        );
        assert_eq!(
            page(PageEvent::TabMessage {
                text: "Is user_id a string?".into(),
                tag: "↳ From “Types”".into(),
                from_tab: "a".into(),
                turn_id: "t3".into(),
                queued: true
            }),
            json!({ "type": "tab-message", "text": "Is user_id a string?", "tag": "↳ From “Types”", "fromTab": "a", "turnId": "t3", "queued": true })
        );
        assert_eq!(
            page(PageEvent::Remote {
                on: false,
                url: None,
                error: None
            }),
            json!({ "type": "remote", "on": false })
        );
    }

    #[test]
    fn the_page_gets_a_shared_chats_names_and_fields() {
        let page = |e: PageEvent| serde_json::to_value(e).unwrap();
        assert_eq!(
            page(PageEvent::ShareSuggestion {
                id: "s1".into(),
                state: Suggestion::Declined,
                why: String::new()
            }),
            json!({ "type": "share-suggestion", "id": "s1", "state": "declined" })
        );
        let from = Person {
            name: "Minh".into(),
            pc: "PC-MINH".into(),
            ip: "10.0.0.2".into(),
            host: false,
        };
        assert_eq!(
            page(PageEvent::ShareSuggest {
                id: "3-a".into(),
                from,
                text: "hi".into(),
                hidden: false
            }),
            json!({ "type": "share-suggest", "id": "3-a", "from": { "name": "Minh", "pc": "PC-MINH", "ip": "10.0.0.2", "host": false },
                "text": "hi", "hidden": false })
        );
        let minh = || Person {
            name: "Minh".into(),
            pc: "PC-MINH".into(),
            ip: "10.0.0.2".into(),
            host: false,
        };
        assert_eq!(
            page(PageEvent::ShareTalk {
                from: minh(),
                text: "hi".into(),
                mine: false
            })["type"],
            "share-talk"
        );
        assert_eq!(
            page(PageEvent::ShareRecommend {
                request_id: "r1".into(),
                from: minh(),
                choice: "Reject".into(),
                why: "it drops the table".into()
            }),
            json!({ "type": "share-recommend", "requestId": "r1", "from": { "name": "Minh", "pc": "PC-MINH", "ip": "10.0.0.2", "host": false },
                "choice": "Reject", "why": "it drops the table" })
        );
        assert_eq!(
            page(PageEvent::ShareDecided {
                request_id: "r1".into(),
                outcome: "approved".into()
            }),
            json!({ "type": "share-decided", "requestId": "r1", "outcome": "approved" })
        );
        assert_eq!(
            page(PageEvent::ShareArrived),
            json!({ "type": "share-arrived" })
        );
        assert_eq!(
            page(PageEvent::ShareTakenBack { id: "x".into() }),
            json!({ "type": "share-taken-back", "id": "x" })
        );
    }
}
