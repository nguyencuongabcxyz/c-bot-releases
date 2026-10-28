//! The coding agents behind the robots: what does the work in a robot's folder. Claude Code
//! for now (claude/: a live conversation, its stream, finding it, its past transcripts);
//! another agent (Codex, …) would go beside it. What an agent reports to the chat is the
//! same whichever it is: an Event (event.rs) carrying what reports.rs defines, so the chat
//! and the robot's page never depend on the agent. A robot's personality (personalities.rs)
//! belongs to the robot, whichever agent it runs.

pub mod claude;
mod event;
pub mod personalities;
mod reports;

pub use event::Event;
pub use reports::*;
