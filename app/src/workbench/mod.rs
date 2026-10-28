//! The workbench: what *you* use in and around a robot's chat: files in the chat, shells and
//! a terminal in its folder, speaking instead of typing, what you paste or drop on it,
//! grabbing text or part of the screen from any app, quick actions on selected text, and the
//! action palette. (Not the tools Claude itself calls: those it gets over MCP, mcp/.)

pub mod capture;
pub mod files;
pub mod palette;
pub mod paste;
pub mod quick;
pub mod shell;
pub mod snip;
pub mod terminal;
pub mod voice;
