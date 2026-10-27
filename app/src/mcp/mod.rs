//! MCP: what Claude itself calls. C-Bot's own MCP server (server.rs: this app's exe, started by
//! Claude Code for each conversation), the tools it gives (tools/), the app's end of it
//! (link.rs: each call over a local socket, and robots asking each other), and MCP Apps
//! (apps.rs: the web views that other servers' tools come with, shown in the chat).

pub mod apps;
pub mod link;
pub mod server;
pub mod tools;
