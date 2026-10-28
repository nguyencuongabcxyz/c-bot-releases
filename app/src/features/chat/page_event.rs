//! What a robot's page hears about a tab's conversation (robot:event, with the tab's id): the
//! names and fields of gui/types/model.ts ChatEvent. What Claude Code reported whole (a diff,
//! a helper, a plan, the answer's end…) goes on as its object, its type added in front.

use serde::Serialize;
use serde_json::Value;

use super::AskKind;

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
        text: Value,
    },
    Usage {
        output_tokens: u64,
    },
    Mode {
        mode: String,
    },
    /// A step: { id, name, detail, args }.
    Tool(Value),
    ToolOutput {
        id: Value,
        text: String,
        media: Value,
        is_error: Value,
    },
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
    Edit(Value),
    Agent(Value),
    Tasks {
        tasks: Vec<Value>,
        change: Value,
    },
    Compact(Value),
    Question(Value),
    RequestCancelled(Value),
    Plan(Value),
    Context {
        context: Value,
    },
    Done(Value),
    Fail(Value),
    /// Questions waiting their turn, dropped (the answer was stopped).
    Dropped {
        turn_ids: Vec<String>,
    },
    Remote {
        on: bool,
        #[serde(skip_serializing_if = "Value::is_null")]
        url: Value,
        #[serde(skip_serializing_if = "Value::is_null")]
        error: Value,
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
            page(PageEvent::ToolOutput {
                id: json!("a"),
                text: "ok".into(),
                media: json!([]),
                is_error: json!(false)
            }),
            json!({ "type": "tool-output", "id": "a", "text": "ok", "media": [], "isError": false })
        );
        assert_eq!(
            page(PageEvent::Done(json!({ "turnId": "t1", "text": "hi" }))),
            json!({ "type": "done", "turnId": "t1", "text": "hi" })
        );
        assert_eq!(
            page(PageEvent::RequestCancelled(json!({ "requestId": "r" }))),
            json!({ "type": "request-cancelled", "requestId": "r" })
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
                url: Value::Null,
                error: Value::Null
            }),
            json!({ "type": "remote", "on": false })
        );
    }
}
