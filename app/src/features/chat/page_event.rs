//! What a robot's page hears about a tab's conversation (robot:event, with the tab's id): the
//! names and fields of gui/types/model.ts ChatEvent. What Claude Code reported whole (a diff,
//! a helper, a plan, the answer's end…) goes on as its object, its type added in front.

use serde::Serialize;
use serde_json::Value;

use super::AskKind;
use crate::agents::claude::{
    AgentEvent, Compact, Diff, Done, Fail, Plan, Question, TaskChange, Tool, ToolOutput,
};

#[derive(Serialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub(super) enum PageEvent {
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
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

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
            output_tokens: json!(3),
            ms: json!(900),
        };
        assert_eq!(
            page(PageEvent::Done {
                done,
                at: json!(42),
                kind: Some(AskKind::Chat)
            }),
            json!({ "type": "done", "turnId": "t1", "text": "hi", "asides": [], "isError": false, "interrupted": false,
                "costUsd": 0.5, "denials": ["Bash"], "sessionId": "s1", "uuid": null, "outputTokens": 3, "ms": 900, "at": 42, "kind": "chat" })
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
            page(PageEvent::Remote {
                on: false,
                url: None,
                error: None
            }),
            json!({ "type": "remote", "on": false })
        );
    }
}
