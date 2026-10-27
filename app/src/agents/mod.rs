//! The coding agents behind the robots: what does the work in a robot's folder. Claude Code
//! for now (claude/: a live conversation, its stream, finding it, its past transcripts);
//! another agent (Codex, …) would go beside it. A robot's personality (personalities.rs)
//! belongs to the robot, whichever agent it runs.

pub mod claude;
pub mod personalities;
