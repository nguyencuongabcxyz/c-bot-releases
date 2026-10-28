//! What a conversation reports to its handler, in order, on a thread of its own (so a handler
//! may wait on the session, e.g. context_usage, without holding up what comes next). The
//! objects are what the robot's page gets (features/chat/events.rs passes them on), under
//! the names name() gives.

use serde_json::Value;
#[cfg(test)]
use serde_json::json;

#[derive(Debug, Clone)]
pub enum Event {
    /// A turn begins (its id: ours, or "auto-…" for one Claude Code started itself).
    TurnStart(String),
    /// The Claude Code conversation it carries on (resumed next time).
    Session(String),
    /// Claude Code's answer to initialize: its models, effort levels and commands.
    Initialized(Value),
    /// A piece of the answer.
    Text(String),
    /// An <aside> remark, said beside the answer.
    Aside(String),
    /// It starts thinking (a step of its own in the answer).
    Thinking,
    ThinkingText(String),
    /// Output tokens of the turn so far.
    Usage(u64),
    /// What it's up to: { text } (a helper's task summary).
    Status(Value),
    /// A tool call: { id, name, detail, args, input (MCP tools) }.
    Tool(Value),
    /// What a tool gave back: { id, text, media, isError }.
    ToolOutput(Value),
    /// An MCP tool's result, as its server gave it: { id, result }.
    ToolResult(Value),
    /// A file it changed: { id, file, hunks, truncated… }.
    Edit(Value),
    /// A helper agent: { op: start | step | text | progress | status | done, id, … }.
    Agent(Value),
    /// Its to-do list: { op: create | update | replace, … }.
    Task(Value),
    /// A question for the user (AskUserQuestion): { requestId, questions }.
    Question(Value),
    /// A plan waiting for the go-ahead (ExitPlanMode): { requestId, plan, file }.
    Plan(Value),
    /// A question or plan no longer wanted: { requestId }.
    RequestCancelled(Value),
    /// Its permission mode changed by itself (into plan mode, or a plan was approved).
    Mode(String),
    /// Its tools: { version, tools, chosen }.
    Tools(Value),
    /// Its slash commands: [{ name, description }].
    Commands(Value),
    /// Compacting its memory: { phase: start | done, pre, post }.
    Compact(Value),
    /// Remote Control on or off: { on, url, remoteSession, error }.
    Remote(Value),
    RemoteState(Value),
    /// A message typed on claude.ai/code or in the Claude app: { uuid, sessionId }.
    RemotePrompt(Value),
    /// The turn's end: { turnId, text, asides, isError, interrupted, costUsd, … }.
    Done(Value),
    /// A turn that couldn't be answered: { turnId, message, cancelled, sessionMissing }.
    Fail(Value),
    /// The process is gone.
    Exit,
}

impl Event {
    /// Its name, as the robot's page knows it.
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
            | Event::Mode(s) => json!(s),
            Event::Usage(n) => json!({ "outputTokens": n }),
            Event::Thinking | Event::Exit => Value::Null,
            Event::Initialized(v)
            | Event::Status(v)
            | Event::Tool(v)
            | Event::ToolOutput(v)
            | Event::ToolResult(v)
            | Event::Edit(v)
            | Event::Agent(v)
            | Event::Task(v)
            | Event::Question(v)
            | Event::Plan(v)
            | Event::RequestCancelled(v)
            | Event::Tools(v)
            | Event::Commands(v)
            | Event::Compact(v)
            | Event::Remote(v)
            | Event::RemoteState(v)
            | Event::RemotePrompt(v)
            | Event::Done(v)
            | Event::Fail(v) => v,
        }
    }
}
