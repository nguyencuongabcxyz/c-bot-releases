//! What Claude Code writes on stdout (stream-json), as types: lines.rs reads each line into a
//! Line and acts on its Kind. The protocol changes from version to version, so reading is as
//! forgiving as reading the JSON by hand was: a field that's missing or of another type reads
//! as empty (text "", a flag false, a number none), a kind of line, block or event we don't
//! know reads as Other, and what goes on to the page as it is (a tool's input, what it gave
//! back) stays JSON.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer};
use serde_json::{Value, json};

/// A line, read: who it's from, and what it is.
pub(super) struct Line {
    /// The conversation it belongs to (Claude Code says it on most lines).
    pub session_id: String,
    /// Set on a helper agent's own messages: its Agent tool call's id.
    pub parent_tool_use_id: String,
    pub kind: Kind,
}

/// A line read; None for output that isn't a message (and a warning for one we can't read).
pub(super) fn parse(line: &str) -> Option<Line> {
    let mut v: Value = serde_json::from_str(line).ok()?;
    if !v.is_object() {
        return None;
    }
    if v.get("type").is_none() {
        // (a result, from versions that left its type out; anything else is Other)
        v["type"] = json!(if v.get("total_cost_usd").is_some() {
            "result"
        } else {
            ""
        });
    }
    let text_of = |k: &str| v[k].as_str().unwrap_or("").to_string();
    let (session_id, parent_tool_use_id) = (text_of("session_id"), text_of("parent_tool_use_id"));
    match Kind::deserialize(v) {
        Ok(kind) => Some(Line {
            session_id,
            parent_tool_use_id,
            kind,
        }),
        Err(err) => {
            let start: String = line.chars().take(300).collect();
            log::warn!("couldn't read a line from Claude Code ({err}): {start}");
            None
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(super) enum Kind {
    /// The answer to a control request we sent.
    ControlResponse {
        #[serde(default, deserialize_with = "lenient")]
        response: ControlResponse,
    },
    /// It asks us something: may it use a tool (and its questions and plans come this way).
    ControlRequest {
        #[serde(default, deserialize_with = "text")]
        request_id: String,
        #[serde(default, deserialize_with = "lenient")]
        request: ControlRequest,
    },
    /// What it asked is no longer wanted.
    ControlCancelRequest {
        #[serde(default, deserialize_with = "text")]
        request_id: String,
    },
    /// A message starts being answered (ours, or one from Remote Control).
    CommandLifecycle {
        #[serde(default, deserialize_with = "text")]
        state: String,
        #[serde(default, deserialize_with = "text")]
        command_uuid: String,
    },
    /// The answer as it's written.
    StreamEvent {
        #[serde(default, deserialize_with = "lenient")]
        event: StreamEvent,
        #[serde(default, deserialize_with = "text")]
        api_message_id: String,
    },
    /// One of its messages, whole.
    Assistant {
        #[serde(default, deserialize_with = "text")]
        uuid: String,
        #[serde(default, deserialize_with = "lenient")]
        message: Message,
    },
    /// What its tools gave back (sent to it as the user's message).
    User {
        #[serde(default, deserialize_with = "lenient")]
        message: Message,
        /// The tool's own account of it (a file's patch, an MCP tool's structured content…).
        #[serde(default)]
        tool_use_result: Value,
    },
    /// What it says about itself.
    System(System),
    /// The turn's end.
    Result(Finished),
    #[serde(other)]
    Other,
}

#[derive(Deserialize, Default)]
pub(super) struct ControlResponse {
    #[serde(default, deserialize_with = "text")]
    pub request_id: String,
    /// "success", or else it failed (error says why).
    #[serde(default, deserialize_with = "text")]
    pub subtype: String,
    #[serde(default, deserialize_with = "text")]
    pub error: String,
    #[serde(default)]
    pub response: Option<Value>,
}

#[derive(Deserialize, Default)]
pub(super) struct ControlRequest {
    /// "can_use_tool" (the only one we answer).
    #[serde(default, deserialize_with = "text")]
    pub subtype: String,
    #[serde(default, deserialize_with = "text")]
    pub tool_name: String,
    #[serde(default)]
    pub input: Value,
}

#[derive(Deserialize, Default)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(super) enum StreamEvent {
    MessageStart {},
    MessageDelta {
        #[serde(default, deserialize_with = "lenient")]
        usage: Usage,
    },
    MessageStop {},
    ContentBlockStart {
        #[serde(default, deserialize_with = "lenient")]
        content_block: Typed,
    },
    ContentBlockDelta {
        #[serde(default, deserialize_with = "lenient")]
        delta: Delta,
    },
    #[default]
    #[serde(other)]
    Other,
}

#[derive(Deserialize, Default)]
pub(super) struct Usage {
    #[serde(default, deserialize_with = "count")]
    pub output_tokens: Option<u64>,
}

/// Just what kind of thing it is (a content block, as it starts).
#[derive(Deserialize, Default)]
pub(super) struct Typed {
    #[serde(default, rename = "type", deserialize_with = "text")]
    pub kind: String,
}

#[derive(Deserialize, Default)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(super) enum Delta {
    #[serde(rename = "text_delta")]
    Text {
        #[serde(default, deserialize_with = "text")]
        text: String,
    },
    #[serde(rename = "thinking_delta")]
    Thinking {
        #[serde(default, deserialize_with = "text")]
        thinking: String,
    },
    #[default]
    #[serde(other)]
    Other,
}

#[derive(Deserialize, Default)]
pub(super) struct Message {
    #[serde(default, deserialize_with = "text")]
    pub id: String,
    /// Its blocks (a message whose content is plain text has none we act on).
    #[serde(default, deserialize_with = "blocks")]
    pub content: Vec<Block>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(super) enum Block {
    Text {
        #[serde(default, deserialize_with = "text")]
        text: String,
    },
    ToolUse {
        #[serde(default, deserialize_with = "text")]
        id: String,
        #[serde(default, deserialize_with = "text")]
        name: String,
        #[serde(default)]
        input: Value,
    },
    ToolResult {
        #[serde(default, deserialize_with = "text")]
        tool_use_id: String,
        /// Text, or a list of text and image blocks.
        #[serde(default)]
        content: Value,
        #[serde(default, deserialize_with = "flag")]
        is_error: bool,
    },
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
#[serde(tag = "subtype", rename_all = "snake_case")]
pub(super) enum System {
    /// It has started: its tools, its slash commands, its version.
    Init {
        #[serde(default)]
        tools: Value,
        #[serde(default)]
        slash_commands: Value,
        #[serde(default)]
        claude_code_version: Value,
    },
    /// Its permission mode (changed by itself: plan mode), or compacting.
    Status {
        #[serde(default, rename = "permissionMode", deserialize_with = "maybe_text")]
        permission_mode: Option<String>,
        #[serde(default, deserialize_with = "text")]
        status: String,
    },
    /// Remote Control's state.
    BridgeState {
        #[serde(default)]
        state: Value,
    },
    CommandsChanged {
        #[serde(default)]
        commands: Value,
    },
    CompactBoundary {
        #[serde(default)]
        compact_metadata: Value,
    },
    /// A helper agent's task: started, at work, its status, done, summed up.
    TaskStarted(Box<HelperTask>),
    TaskProgress(Box<HelperTask>),
    TaskUpdated(Box<HelperTask>),
    TaskNotification(Box<HelperTask>),
    TaskSummary(Box<HelperTask>),
    #[serde(other)]
    Other,
}

/// What a helper agent's task events say (each says some of it).
#[derive(Deserialize, Default)]
pub(super) struct HelperTask {
    #[serde(default, deserialize_with = "text")]
    pub task_id: String,
    /// The Agent tool call it belongs to (else known from its task_id).
    #[serde(default, deserialize_with = "text")]
    pub tool_use_id: String,
    /// { total_tokens, tool_uses, duration_ms }
    #[serde(default)]
    pub usage: Value,
    #[serde(default)]
    pub description: Value,
    #[serde(default, deserialize_with = "text")]
    pub subagent_type: String,
    #[serde(default, deserialize_with = "text")]
    pub prompt: String,
    #[serde(default, deserialize_with = "flag")]
    pub is_backgrounded: bool,
    /// (task_updated) what changed: { status }
    #[serde(default)]
    pub patch: Value,
    #[serde(default, deserialize_with = "text")]
    pub status: String,
    #[serde(default, deserialize_with = "text")]
    pub summary: String,
    #[serde(default, deserialize_with = "text")]
    pub output_file: String,
    /// (task_summary) what it's up to
    #[serde(default)]
    pub detail: Value,
}

#[derive(Deserialize, Default)]
pub(super) struct Finished {
    /// The whole process's cost so far (US$).
    #[serde(default, deserialize_with = "number")]
    pub total_cost_usd: Option<f64>,
    /// "abort…" when it was stopped.
    #[serde(default, deserialize_with = "text")]
    pub terminal_reason: String,
    /// Its answer, as Claude Code sums it up.
    #[serde(default, deserialize_with = "text")]
    pub result: String,
    #[serde(default, deserialize_with = "flag")]
    pub is_error: bool,
    #[serde(default, deserialize_with = "lenient")]
    pub permission_denials: Vec<Denial>,
    #[serde(default)]
    pub usage: Value,
    #[serde(default)]
    pub duration_ms: Value,
}

/// A tool it wasn't allowed to use.
#[derive(Deserialize, Default)]
pub(super) struct Denial {
    #[serde(default)]
    pub tool_name: Value,
}

/// A model Claude Code offers (from its answer to initialize).
#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    /// What --model takes ("default": its own choice).
    #[serde(default, deserialize_with = "text")]
    pub value: String,
    #[serde(default)]
    pub display_name: Value,
    #[serde(default)]
    pub description: Value,
    /// The effort levels it takes.
    #[serde(default)]
    pub supported_effort_levels: Option<Value>,
}

/// The models in Claude Code's answer to initialize (one it can't read is left out).
pub(super) fn models_of(info: &Value) -> Vec<Model> {
    info["models"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| Model::deserialize(m).ok())
        .collect()
}

// ---------------------------------------------------------------- reading forgivingly

/// Text, or "" for anything else (as `s()` reads it).
fn text<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    Ok(match Value::deserialize(d)? {
        Value::String(s) => s,
        _ => String::new(),
    })
}

fn maybe_text<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Ok(match Value::deserialize(d)? {
        Value::String(s) => Some(s),
        _ => None,
    })
}

/// true only for true.
fn flag<'de, D: Deserializer<'de>>(d: D) -> Result<bool, D::Error> {
    Ok(Value::deserialize(d)?.as_bool().unwrap_or(false))
}

fn number<'de, D: Deserializer<'de>>(d: D) -> Result<Option<f64>, D::Error> {
    Ok(Value::deserialize(d)?.as_f64())
}

fn count<'de, D: Deserializer<'de>>(d: D) -> Result<Option<u64>, D::Error> {
    Ok(Value::deserialize(d)?.as_u64())
}

/// A part of the line, read as its type; its default when it isn't one.
fn lenient<'de, D: Deserializer<'de>, T: DeserializeOwned + Default>(d: D) -> Result<T, D::Error> {
    Ok(T::deserialize(Value::deserialize(d)?).unwrap_or_default())
}

/// A message's content blocks; a block we can't read is Other, plain text content none.
fn blocks<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<Block>, D::Error> {
    Ok(match Value::deserialize(d)? {
        Value::Array(items) => items
            .into_iter()
            .map(|b| Block::deserialize(b).unwrap_or(Block::Other))
            .collect(),
        _ => vec![],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kind(v: Value) -> Kind {
        parse(&v.to_string()).expect("read").kind
    }

    #[test]
    fn its_messages_read_as_their_kinds() {
        let line = parse(&json!({ "type": "assistant", "session_id": "s1", "parent_tool_use_id": null, "uuid": "u1", "message": { "id": "m1", "content": [
            { "type": "thinking", "thinking": "hm" },
            { "type": "text", "text": "Hi" },
            { "type": "tool_use", "id": "t1", "name": "Read", "input": { "file_path": "a.txt" } },
        ] } }).to_string()).unwrap();
        assert_eq!(
            (line.session_id.as_str(), line.parent_tool_use_id.as_str()),
            ("s1", "")
        );
        let Kind::Assistant { uuid, message } = line.kind else {
            panic!("not assistant")
        };
        assert_eq!((uuid.as_str(), message.id.as_str()), ("u1", "m1"));
        assert!(matches!(message.content[0], Block::Other));
        assert!(matches!(&message.content[1], Block::Text { text } if text == "Hi"));
        assert!(
            matches!(&message.content[2], Block::ToolUse { id, name, input } if id == "t1" && name == "Read" && input["file_path"] == "a.txt")
        );

        let Kind::User {
            message,
            tool_use_result,
        } = kind(json!({ "type": "user", "message": { "content": [
            { "type": "tool_result", "tool_use_id": "t1", "content": "file", "is_error": null },
        ] }, "tool_use_result": { "filePath": "a.txt" } }))
        else {
            panic!("not user")
        };
        assert!(
            matches!(&message.content[0], Block::ToolResult { tool_use_id, content, is_error: false } if tool_use_id == "t1" && content == "file")
        );
        assert_eq!(tool_use_result["filePath"], "a.txt");

        // (a user message that's plain text: no blocks)
        let Kind::User { message, .. } =
            kind(json!({ "type": "user", "message": { "content": "hello" } }))
        else {
            panic!()
        };
        assert!(message.content.is_empty());
    }

    #[test]
    fn the_stream_reads_as_its_events() {
        let event = |e: Value| match kind(
            json!({ "type": "stream_event", "event": e, "api_message_id": "a1" }),
        ) {
            Kind::StreamEvent {
                event,
                api_message_id,
            } => (event, api_message_id),
            _ => panic!("not a stream event"),
        };
        assert!(
            matches!(event(json!({ "type": "content_block_delta", "delta": { "type": "text_delta", "text": "He" } })),
            (StreamEvent::ContentBlockDelta { delta: Delta::Text { text } }, id) if text == "He" && id == "a1")
        );
        assert!(
            matches!(event(json!({ "type": "content_block_delta", "delta": { "type": "thinking_delta", "thinking": "so" } })).0,
            StreamEvent::ContentBlockDelta { delta: Delta::Thinking { thinking } } if thinking == "so")
        );
        assert!(matches!(
            event(json!({ "type": "message_delta", "usage": { "output_tokens": 12 } })).0,
            StreamEvent::MessageDelta {
                usage: Usage {
                    output_tokens: Some(12)
                }
            }
        ));
        assert!(
            matches!(event(json!({ "type": "content_block_start", "content_block": { "type": "thinking" } })).0,
            StreamEvent::ContentBlockStart { content_block } if content_block.kind == "thinking")
        );
        assert!(matches!(
            event(json!({ "type": "message_start", "message": { "id": "m" } })).0,
            StreamEvent::MessageStart {}
        ));
        assert!(matches!(
            event(json!({ "type": "a_new_one" })).0,
            StreamEvent::Other
        ));
        // (a delta of a kind we don't know, or not even an object)
        assert!(matches!(
            event(json!({ "type": "content_block_delta", "delta": { "type": "signature_delta" } }))
                .0,
            StreamEvent::ContentBlockDelta {
                delta: Delta::Other
            }
        ));
        assert!(matches!(
            event(json!({ "type": "content_block_delta", "delta": 5 })).0,
            StreamEvent::ContentBlockDelta {
                delta: Delta::Other
            }
        ));
    }

    #[test]
    fn what_it_says_about_itself_reads_by_subtype() {
        assert!(
            matches!(kind(json!({ "type": "system", "subtype": "init", "tools": ["Read"], "claude_code_version": "2.1.311" })),
            Kind::System(System::Init { tools, claude_code_version, .. }) if tools[0] == "Read" && claude_code_version == "2.1.311")
        );
        assert!(
            matches!(kind(json!({ "type": "system", "subtype": "status", "permissionMode": "plan" })),
            Kind::System(System::Status { permission_mode: Some(m), .. }) if m == "plan")
        );
        assert!(
            matches!(kind(json!({ "type": "system", "subtype": "task_notification", "task_id": "k", "status": "failed", "summary": "no" })),
            Kind::System(System::TaskNotification(t)) if t.task_id == "k" && t.status == "failed" && t.summary == "no")
        );
        assert!(matches!(
            kind(json!({ "type": "system", "subtype": "hook_started" })),
            Kind::System(System::Other)
        ));
    }

    #[test]
    fn the_end_and_the_controls_read_too() {
        let Kind::Result(f) = kind(
            json!({ "type": "result", "total_cost_usd": 0.25, "result": "Done", "is_error": false,
            "terminal_reason": "completed", "permission_denials": [{ "tool_name": "Bash" }], "usage": { "output_tokens": 9 }, "duration_ms": 1200 }),
        ) else {
            panic!()
        };
        assert_eq!(
            (
                f.total_cost_usd,
                f.result.as_str(),
                f.permission_denials[0].tool_name.as_str()
            ),
            (Some(0.25), "Done", Some("Bash"))
        );
        assert_eq!(
            (f.usage["output_tokens"].as_u64(), f.duration_ms.as_u64()),
            (Some(9), Some(1200))
        );
        // (a result with its type left out)
        assert!(
            matches!(kind(json!({ "total_cost_usd": 0.1, "result": "x" })), Kind::Result(f) if f.result == "x")
        );
        let Kind::ControlRequest {
            request_id,
            request,
        } = kind(json!({ "type": "control_request", "request_id": "r1",
            "request": { "subtype": "can_use_tool", "tool_name": "ExitPlanMode", "input": { "plan": "1." } } }))
        else {
            panic!()
        };
        assert_eq!(
            (
                request_id.as_str(),
                request.subtype.as_str(),
                request.tool_name.as_str()
            ),
            ("r1", "can_use_tool", "ExitPlanMode")
        );
        assert!(
            matches!(kind(json!({ "type": "control_response", "response": { "subtype": "error", "request_id": "c1", "error": "no" } })),
            Kind::ControlResponse { response } if response.request_id == "c1" && response.error == "no" && response.response.is_none())
        );
        assert!(matches!(kind(json!({ "type": "keep_alive" })), Kind::Other));
        assert!(parse("not json").is_none() && parse("[1]").is_none());
    }
}
