//! MCP: what Claude itself calls. C-Bot's own MCP server (server.rs: this app's exe, started by
//! Claude Code for each conversation), the tools it gives (tools/), the app's end of it
//! (link.rs: each call over a local socket, and robots asking each other), MCP Apps
//! (apps.rs: the web views that other servers' tools come with, shown in the chat), and the
//! edit guard (guard.rs: a hook, so two tabs don't change one file at once).

pub mod apps;
pub mod guard;
pub mod link;
pub mod server;
pub mod tools;
