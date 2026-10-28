//! What an agent's conversation reports (the payloads of its Events), as the robot's page gets them:
//! the names and fields of gui/types/model.ts (Diff, AgentEvent, TaskChange, Question and
//! the robot:event ones), so PageEvent (features/chat/page_event.rs) passes them on as they
//! are. What only goes through (a tool's input and what it gave back, its media) stays JSON.

use serde::Serialize;
use serde_json::Value;

/// A model it offers, for the chat's model picker.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ModelChoice {
    /// What the agent takes to use it ("": its own default).
    pub value: String,
    pub display_name: Value,
    pub description: Value,
    /// The effort levels it takes.
    pub efforts: Value,
}

/// The turn's end.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Done {
    pub turn_id: String,
    pub text: String,
    pub asides: Vec<String>,
    pub is_error: bool,
    pub interrupted: bool,
    /// What this turn cost (US$).
    pub cost_usd: f64,
    /// Tools it wasn't allowed to use.
    pub denials: Vec<String>,
    pub session_id: Option<String>,
    /// Its last message in the transcript (an edited question after it rewinds to here).
    pub uuid: Option<String>,
    pub output_tokens: Value,
    pub ms: Value,
}

/// A turn that couldn't be answered.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Fail {
    pub turn_id: String,
    pub message: String,
    pub cancelled: bool,
    /// The conversation it carries on is gone (its folder moved): asking afresh may do.
    pub session_missing: bool,
}

/// A tool call: a step in the answer.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Tool {
    pub id: String,
    pub name: String,
    /// What it's doing, in a few words.
    pub detail: String,
    pub args: Value,
    /// (MCP tools) its input as given, for a view that draws from it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<Value>,
}

/// What a tool gave back, as Claude read it.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ToolOutput {
    pub id: String,
    pub text: String,
    /// Its pictures and documents (StepMedia).
    pub media: Value,
    pub is_error: bool,
}

/// An MCP tool's result, as its server gave it.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    pub id: String,
    pub result: Value,
}

/// A file it changed, as unified-diff hunks.
#[derive(Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Diff {
    /// The tool call that changed it.
    pub id: String,
    pub file: String,
    pub created: bool,
    pub added: usize,
    pub removed: usize,
    pub hunks: Vec<Hunk>,
    /// Some of it was left out (it was long).
    pub truncated: bool,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    pub old_start: i64,
    pub new_start: i64,
    /// "+…", "-…" or " …"
    pub lines: Vec<String>,
}

/// A helper agent: its card in the chat.
#[derive(Serialize, Debug, Clone)]
#[serde(tag = "op", rename_all = "lowercase", rename_all_fields = "camelCase")]
pub enum AgentEvent {
    Start {
        id: String,
        /// The helper that sent it, if a helper did.
        #[serde(skip_serializing_if = "Option::is_none")]
        parent: Option<String>,
        description: String,
        kind: String,
        prompt: String,
        background: bool,
    },
    Step {
        id: String,
        tool: String,
        detail: String,
    },
    Text {
        id: String,
        text: String,
    },
    Progress {
        id: String,
        activity: String,
        #[serde(flatten)]
        usage: HelperUsage,
    },
    Status {
        id: String,
        status: String,
    },
    Done {
        id: String,
        status: String,
        summary: String,
        /// (a background helper) the file its full report is in: the chat reads it into report
        #[serde(skip_serializing_if = "Option::is_none")]
        output_file: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        report: Option<String>,
        #[serde(flatten)]
        usage: HelperUsage,
    },
}

/// A helper's work so far, when Claude Code says it.
#[derive(Serialize, Debug, Clone, Default)]
pub struct HelperUsage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ms: Option<Value>,
}

/// A change to its to-do list (the card).
#[derive(Serialize, Debug, Clone)]
#[serde(tag = "op", rename_all = "lowercase", rename_all_fields = "camelCase")]
pub enum TaskChange {
    /// A task added (TaskCreate), with the number Claude Code gave it.
    Create {
        id: String,
        subject: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        active_form: Option<String>,
        status: String,
    },
    /// A task changed (TaskUpdate): what it says changed.
    Update {
        id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        status: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        subject: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        active_form: Option<String>,
    },
    /// The whole list (TodoWrite).
    Replace { tasks: Vec<TodoItem> },
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TodoItem {
    pub id: String,
    pub subject: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_form: Option<String>,
    pub status: String,
}

/// Questions for the user (AskUserQuestion), waiting for the answers.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Question {
    pub request_id: String,
    /// [{ question, header, multiSelect, options }], as Claude asked them.
    pub questions: Value,
}

/// A plan (ExitPlanMode), waiting for the go-ahead.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub request_id: String,
    pub plan: String,
    /// Where Claude Code keeps it.
    pub file: String,
}

/// Compacting its memory: started, or done (how many tokens before and after).
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Compact {
    pub phase: CompactPhase,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pre: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub post: Option<f64>,
}

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CompactPhase {
    Start,
    Done,
}

/// Remote Control on (its page on claude.ai), off, or couldn't.
#[derive(Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Remote {
    pub on: bool,
    pub url: Option<String>,
    /// The remote session (a new process picks it up again).
    pub remote_session: Option<String>,
    pub error: Option<String>,
}

/// A message typed on claude.ai/code or in the Claude app (its words are in the transcript).
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RemotePrompt {
    pub uuid: String,
    pub session_id: String,
}

/// The agent's tools, as it started.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Tools {
    pub version: String,
    pub tools: Vec<String>,
    /// We picked them (--tools), rather than Claude Code's defaults.
    pub chosen: bool,
}

/// A slash command it offers (a skill, a custom command).
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SlashCommand {
    pub name: String,
    /// "" when it gave only the name.
    pub description: String,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn they_read_as_the_page_knows_them() {
        let agent = AgentEvent::Done {
            id: "a".into(),
            status: "completed".into(),
            summary: "ok".into(),
            output_file: None,
            report: None,
            usage: HelperUsage {
                tokens: Some(json!(12)),
                ..Default::default()
            },
        };
        assert_eq!(
            json!(agent),
            json!({ "op": "done", "id": "a", "status": "completed", "summary": "ok", "tokens": 12 })
        );
        let start = AgentEvent::Start {
            id: "a".into(),
            parent: None,
            description: "Look".into(),
            kind: "".into(),
            prompt: "p".into(),
            background: false,
        };
        assert_eq!(
            json!(start),
            json!({ "op": "start", "id": "a", "description": "Look", "kind": "", "prompt": "p", "background": false })
        );
        let change = TaskChange::Update {
            id: "1".into(),
            status: Some("completed".into()),
            subject: None,
            active_form: None,
        };
        assert_eq!(
            json!(change),
            json!({ "op": "update", "id": "1", "status": "completed" })
        );
        let list = TaskChange::Replace {
            tasks: vec![TodoItem {
                id: "1".into(),
                subject: "Write".into(),
                active_form: Some("Writing".into()),
                status: "pending".into(),
            }],
        };
        assert_eq!(
            json!(list),
            json!({ "op": "replace", "tasks": [{ "id": "1", "subject": "Write", "activeForm": "Writing", "status": "pending" }] })
        );
        let diff = Diff {
            file: "a.txt".into(),
            created: true,
            added: 1,
            hunks: vec![Hunk {
                old_start: 0,
                new_start: 1,
                lines: vec!["+hi".into()],
            }],
            ..Default::default()
        };
        assert_eq!(
            json!(diff),
            json!({ "id": "", "file": "a.txt", "created": true, "added": 1, "removed": 0, "hunks": [{ "oldStart": 0, "newStart": 1, "lines": ["+hi"] }], "truncated": false })
        );
        assert_eq!(
            json!(Compact {
                phase: CompactPhase::Start,
                pre: None,
                post: None
            }),
            json!({ "phase": "start" })
        );
        assert_eq!(
            json!(Fail {
                turn_id: "t".into(),
                message: "m".into(),
                cancelled: false,
                session_missing: true
            }),
            json!({ "turnId": "t", "message": "m", "cancelled": false, "sessionMissing": true })
        );
    }
}
