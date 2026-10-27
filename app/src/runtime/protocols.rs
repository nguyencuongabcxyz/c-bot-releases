//! The app's own URL schemes, each answered off the page's thread.

use std::thread;

use tauri::{Builder, Wry};

use crate::mcp::apps;
use crate::workbench::files;
use super::paths::picture_roots;

pub fn register(builder: Builder<Wry>) -> Builder<Wry> {
    builder
        // local pictures in the chat (cbot-file://img/?path=…) and the file viewer's PDFs,
        // songs and videos (view/?path=…)
        .register_asynchronous_uri_scheme_protocol("cbot-file", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            thread::spawn(move || {
                let allowed = picture_roots(&app);
                responder.respond(files::serve(&request, &allowed));
            });
        })
        // MCP tool views (http://cbot-app.localhost/<page>/), each with its own CSP (mcp/apps.rs)
        .register_asynchronous_uri_scheme_protocol("cbot-app", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            thread::spawn(move || responder.respond(apps::serve_page(&app, request.uri())));
        })
}
