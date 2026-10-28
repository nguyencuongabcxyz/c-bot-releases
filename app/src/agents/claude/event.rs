//! What a conversation reports to its handler, in order, on a thread of its own (so a handler
//! may wait on the session, e.g. context_usage, without holding up what comes next). What
//! each carries is typed (reports.rs), the way the robot's page gets it (features/chat/events.rs
//! passes it on, as its PageEvent).

#[cfg(test)]
use serde_json::{Value, json};

use super::protocol::Model;
use super::reports::*;

#[derive(Debug, Clone)]
pub enum Event {
    /// A turn begins (its id: ours, or "auto-…" for one Claude Code started itself).
    TurnStart(String),
    /// The Claude Code conversation it carries on (resumed next time).
    Session(String),
    /// The models Claude Code offers (its answer to initialize).
    Initialized(Vec<Model>),
    /// A piece of the answer.
    Text(String),
    /// An <aside> remark, said beside the answer.
    Aside(String),
    /// It starts thinking (a step of its own in the answer).
    Thinking,
    ThinkingText(String),
    /// Output tokens of the turn so far.
    Usage(u64),
    /// What it's up to (a helper's task summary).
    Status(String),
    Tool(Tool),
    ToolOutput(ToolOutput),
    ToolResult(ToolResult),
    Edit(Diff),
    Agent(AgentEvent),
    Task(TaskChange),
    Question(Question),
    Plan(Plan),
    /// A question or plan no longer wanted (its request id).
    RequestCancelled(String),
    /// Its permission mode changed by itself (into plan mode, or a plan was approved).
    Mode(String),
    Tools(Tools),
    Commands(Vec<SlashCommand>),
    Compact(Compact),
    Remote(Remote),
    /// Remote Control's state, as Claude Code says it.
    RemoteState(serde_json::Value),
    RemotePrompt(RemotePrompt),
    Done(Done),
    Fail(Fail),
    /// The process is gone.
    Exit,
}

impl Event {
    /// Its name (the live tests look for it).
    #[cfg(test)]
    pub fn name(&self) -> &'static str {
        match self {
            Event::TurnStart(_) => "turn-start",
            Event::Session(_) => "session",
            Event::Initialized(_) => "initialized",
            Event::Text(_) => "text",
            Event::Aside(_) => "aside",
            Event::Thinking => "thinking",
            Event::ThinkingText(_) => "thinking-text",
            Event::Usage(_) => "usage",
            Event::Status(_) => "status",
            Event::Tool(_) => "tool",
            Event::ToolOutput(_) => "tool-output",
            Event::ToolResult(_) => "tool-result",
            Event::Edit(_) => "edit",
            Event::Agent(_) => "agent",
            Event::Task(_) => "task",
            Event::Question(_) => "question",
            Event::Plan(_) => "plan",
            Event::RequestCancelled(_) => "request-cancelled",
            Event::Mode(_) => "mode",
            Event::Tools(_) => "tools",
            Event::Commands(_) => "commands",
            Event::Compact(_) => "compact",
            Event::Remote(_) => "remote",
            Event::RemoteState(_) => "remote-state",
            Event::RemotePrompt(_) => "remote-prompt",
            Event::Done(_) => "done",
            Event::Fail(_) => "fail",
            Event::Exit => "exit",
        }
    }

    /// What it carries, as JSON (the live tests look at it that way).
    #[cfg(test)]
    pub fn data(self) -> Value {
        match self {
            Event::TurnStart(s)
            | Event::Session(s)
            | Event::Text(s)
            | Event::Aside(s)
            | Event::ThinkingText(s)
            | Event::Status(s)
            | Event::RequestCancelled(s)
            | Event::Mode(s) => json!(s),
            Event::Usage(n) => json!({ "outputTokens": n }),
            Event::Thinking | Event::Exit => Value::Null,
            Event::Initialized(models) => json!(models.len()),
            Event::Tool(v) => json!(v),
            Event::ToolOutput(v) => json!(v),
            Event::ToolResult(v) => json!(v),
            Event::Edit(v) => json!(v),
            Event::Agent(v) => json!(v),
            Event::Task(v) => json!(v),
            Event::Question(v) => json!(v),
            Event::Plan(v) => json!(v),
            Event::Tools(v) => json!(v),
            Event::Commands(v) => json!(v),
            Event::Compact(v) => json!(v),
            Event::Remote(v) => json!(v),
            Event::RemoteState(v) => v,
            Event::RemotePrompt(v) => json!(v),
            Event::Done(v) => json!(v),
            Event::Fail(v) => json!(v),
        }
    }
}
