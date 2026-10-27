//! What every system shares: plain types (types.rs: Rect, Monitor, Key, Failure), and what's
//! built the same everywhere on each system's own calls: the keyboard and mouse (input.rs:
//! waiting for keys to come up, how long you've been away) and pictures made ready for the
//! chat (image.rs).

pub mod image;
pub mod input;
pub mod types;
