//! The runtime: the app's own life. Its state (with()), starting up and shutting down
//! (setup.rs), every command the pages can call (commands.rs) and its URL schemes
//! (protocols.rs), what the parts share (hub.rs: hotkeys, telling a robot something), older
//! data brought up to date (migrate.rs), updates (updater.rs), and the small helpers for what
//! a page sent (util.rs).

pub mod commands;
pub mod hub;
pub mod migrate;
pub mod paths;
pub mod protocols;
pub mod setup;
mod state;
pub mod updater;
pub mod util;

pub use state::{State, with};
