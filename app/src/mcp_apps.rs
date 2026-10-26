//! MCP Apps (main mcpApps.js, main.js openAppWindow and the robot:app-* handlers): some MCP
//! tools come with their own little web page (a "ui://" resource) that shows what the tool
//! did (Excalidraw's create_view draws the diagram there). Claude Code runs the tool; we fetch
//! that page from the same server and host it in the chat, the way Claude Desktop does:
//! sandboxed, from the cbot-app protocol (http://cbot-app.localhost/<page>/ under WebView2)
//! with a Content-Security-Policy of its own, and big in a window of its own ("appview-<n>").

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use regex::Regex;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::util::text;
use crate::{robots, views, win, with};

/// Where the pages are served from (the cbot-app protocol, as WebView2 serves it).
const PAGE_BASE: &str = "http://cbot-app.localhost/";
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);

// claude.ai connectors run behind Anthropic's proxy, so we can't reach them the way Claude
// Code does. These ones are public, so we talk to them directly.
const KNOWN_SERVERS: [(&str, &str); 1] = [("claude_ai_Excalidraw", "https://mcp.excalidraw.com/mcp")];

// What the page may ask its server for, through us.
const APP_METHODS: [&str; 6] = ["tools/call", "tools/list", "resources/read", "resources/list", "resources/templates/list", "prompts/list"];

/// Claude Code names tools mcp__<server>__<tool>, with the server name made safe.
fn safe_name(name: &str) -> String {
    name.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' }).collect()
}

/// "mcp__claude_ai_Excalidraw__create_view" -> ("claude_ai_Excalidraw", "create_view")
pub fn parse_tool_name(name: &str) -> Option<(String, String)> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"^mcp__(.+?)__(.+)$").unwrap());
    let m = re.captures(name)?;
    Some((m[1].to_string(), m[2].to_string()))
}

#[derive(Clone, Debug, PartialEq)]
struct ServerCfg {
    url: String,
    headers: Vec<(String, String)>,
}

fn read_json(file: &Path) -> Value {
    std::fs::read_to_string(file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null)
}

/// An HTTP MCP server from the user's Claude Code config (user scope, the folder's project
/// scope and its .mcp.json). Servers needing OAuth won't answer us; that's fine.
fn configured_server(server: &str, folder: &str, user: &Value, shared: &Value) -> Option<ServerCfg> {
    let projects = &user["projects"];
    let project = if projects[folder].is_object() { &projects[folder] } else { &projects[folder.replace('\\', "/").as_str()] };
    for servers in [&project["mcpServers"], &shared["mcpServers"], &user["mcpServers"]] {
        for (name, cfg) in servers.as_object().into_iter().flatten() {
            let url = cfg["url"].as_str().unwrap_or("");
            if safe_name(name) != server || url.is_empty() || cfg["type"] == "sse" {
                continue;
            }
            let headers = cfg["headers"].as_object().into_iter().flatten().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string()))).collect();
            return Some(ServerCfg { url: url.to_string(), headers });
        }
    }
    None
}

fn server_cfg(server: &str, folder: &str) -> Option<ServerCfg> {
    if let Some((_, url)) = KNOWN_SERVERS.iter().find(|(s, _)| *s == server) {
        return Some(ServerCfg { url: url.to_string(), headers: vec![] });
    }
    let home = PathBuf::from(std::env::var_os("USERPROFILE").unwrap_or_default());
    let user = read_json(&home.join(".claude.json"));
    let shared = if folder.is_empty() { Value::Null } else { read_json(&Path::new(folder).join(".mcp.json")) };
    configured_server(server, folder, &user, &shared)
}

// ---------------------------------------------------------------- a tiny MCP client

#[derive(Debug)]
struct RpcError {
    message: String,
    code: Option<i64>,
}

impl RpcError {
    fn new(message: impl Into<String>) -> RpcError {
        RpcError { message: message.into(), code: None }
    }
}

/// Runs the HTTP off the async runtime the IPC calls come on (reqwest's blocking client
/// mustn't be used from inside one).
fn off_runtime<T: Send>(f: impl FnOnce() -> T + Send) -> Option<T> {
    thread::scope(|s| s.spawn(f).join().ok())
}

fn http() -> Option<&'static reqwest::blocking::Client> {
    static CLIENT: OnceLock<Option<reqwest::blocking::Client>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            let _ = rustls::crypto::ring::default_provider().install_default(); // (as the updater does)
            reqwest::blocking::Client::builder().timeout(HTTP_TIMEOUT).build().map_err(|e| eprintln!("[mcp apps] no HTTP client: {e}")).ok()
        })
        .as_ref()
}

/// The JSON-RPC messages in a reply: one JSON body, or an event stream's data lines.
fn messages_in(body: &str, event_stream: bool) -> Result<Vec<Value>, RpcError> {
    let parse = |t: &str| serde_json::from_str::<Value>(t.trim()).map_err(|e| RpcError::new(format!("The MCP server sent back something unreadable ({e})")));
    if event_stream {
        body.lines().filter_map(|l| l.strip_prefix("data:")).map(parse).collect()
    } else {
        Ok(vec![parse(body)?])
    }
}

/// The answer to request `id` among them.
fn reply_to(messages: Vec<Value>, id: &Value) -> Result<Value, RpcError> {
    let reply = messages.into_iter().find(|m| &m["id"] == id).ok_or_else(|| RpcError::new("No answer from the MCP server"))?;
    if !reply["error"].is_null() {
        let e = &reply["error"];
        return Err(RpcError { message: e["message"].as_str().filter(|m| !m.is_empty()).unwrap_or("MCP error").to_string(), code: e["code"].as_i64() });
    }
    Ok(reply.get("result").cloned().unwrap_or(Value::Null))
}

/// A streamable-HTTP MCP client: initialize once, then JSON-RPC requests.
struct McpHttp {
    cfg: ServerCfg,
    session_id: Option<String>,
    next_id: u64,
    ready: bool,
}

impl McpHttp {
    fn post(&mut self, body: &Value) -> Result<Value, RpcError> {
        let client = http().ok_or_else(|| RpcError::new("No way to reach the MCP server"))?;
        let mut req = client
            .post(&self.cfg.url)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream")
            .header("MCP-Protocol-Version", "2025-06-18");
        if let Some(sid) = &self.session_id {
            req = req.header("Mcp-Session-Id", sid);
        }
        for (k, v) in &self.cfg.headers {
            req = req.header(k, v);
        }
        let res = req.body(body.to_string()).send().map_err(|e| RpcError::new(format!("{} isn't reachable ({e})", self.cfg.url)))?;
        if !res.status().is_success() {
            return Err(RpcError::new(format!("{} answered {}", self.cfg.url, res.status().as_u16())));
        }
        if let Some(sid) = res.headers().get("mcp-session-id").and_then(|v| v.to_str().ok()) {
            self.session_id = Some(sid.to_string());
        }
        if body.get("id").is_none() {
            return Ok(Value::Null); // a notification
        }
        let stream = res.headers().get("content-type").and_then(|v| v.to_str().ok()).is_some_and(|t| t.contains("text/event-stream"));
        let text = res.text().map_err(|e| RpcError::new(format!("{} broke off ({e})", self.cfg.url)))?;
        reply_to(messages_in(&text, stream)?, &body["id"])
    }

    fn call(&mut self, method: &str, params: Value) -> Result<Value, RpcError> {
        self.next_id += 1;
        let id = self.next_id;
        self.post(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))
    }

    fn request(&mut self, method: &str, params: Value) -> Result<Value, RpcError> {
        if !self.ready {
            // (a failure tries again next time)
            let init = json!({
                "protocolVersion": "2025-06-18",
                "capabilities": { "extensions": { "io.modelcontextprotocol/ui": { "mimeTypes": ["text/html;profile=mcp-app"] } } },
                "clientInfo": { "name": "C-Bot", "version": "0.1.0" },
            });
            self.call("initialize", init)?;
            self.post(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))?;
            self.ready = true;
        }
        self.call(method, params)
    }
}

// ---------------------------------------------------------------- what's kept

struct Page {
    html: String,
    meta: Value,
}

#[derive(Default)]
struct Apps {
    clients: HashMap<String, Option<Arc<Mutex<McpHttp>>>>, // server -> its client (None: out of reach)
    tool_lists: HashMap<String, Vec<Value>>,
    pages: HashMap<String, Page>,             // page key -> its page
    windows: HashMap<String, (String, Value)>, // "appview-<n>" -> (robot id, the view it shows)
}

fn apps<R>(app: &AppHandle, f: impl FnOnce(&mut Apps) -> R) -> R {
    match app.try_state::<Mutex<Apps>>() {
        Some(state) => f(&mut state.lock().unwrap_or_else(|e| e.into_inner())),
        None => f(&mut Apps::default()),
    }
}

fn client_for(app: &AppHandle, server: &str, folder: &str) -> Option<Arc<Mutex<McpHttp>>> {
    if let Some(c) = apps(app, |a| a.clients.get(server).cloned()) {
        return c;
    }
    let client = server_cfg(server, folder).map(|cfg| Arc::new(Mutex::new(McpHttp { cfg, session_id: None, next_id: 0, ready: false })));
    apps(app, |a| a.clients.entry(server.to_string()).or_insert(client).clone())
}

fn request(client: &Arc<Mutex<McpHttp>>, method: &str, params: Value) -> Result<Value, RpcError> {
    let client = client.clone();
    let method = method.to_string();
    off_runtime(move || client.lock().unwrap_or_else(|e| e.into_inner()).request(&method, params)).unwrap_or_else(|| Err(RpcError::new("The MCP request failed")))
}

fn tools_of(app: &AppHandle, server: &str, folder: &str) -> Result<Vec<Value>, RpcError> {
    if let Some(list) = apps(app, |a| a.tool_lists.get(server).cloned()) {
        return Ok(list);
    }
    let Some(client) = client_for(app, server, folder) else { return Ok(vec![]) };
    let list = request(&client, "tools/list", json!({}))?["tools"].as_array().cloned().unwrap_or_default();
    apps(app, |a| a.tool_lists.insert(server.to_string(), list.clone()));
    Ok(list)
}

fn ui_of(tool: &Value) -> Option<String> {
    let meta = &tool["_meta"];
    meta["ui"]["resourceUri"].as_str().or(meta["ui/resourceUri"].as_str()).filter(|u| !u.is_empty()).map(str::to_string)
}

/// A page's key: its address on the cbot-app protocol.
fn page_key(server: &str, uri: &str) -> String {
    let mut h = std::hash::DefaultHasher::new();
    format!("{server}\n{uri}").hash(&mut h);
    let a = h.finish();
    uri.hash(&mut h);
    format!("{a:016x}{:04x}", h.finish() & 0xffff)
}

/// The page's Content-Security-Policy, from the domains the app declares (MCP Apps rules).
fn csp_for(meta: &Value) -> String {
    static DOMAIN: OnceLock<Regex> = OnceLock::new();
    let domain = DOMAIN.get_or_init(|| Regex::new(r"^https://[\w.-]+(:\d+)?$").unwrap());
    let csp = &meta["csp"];
    let list = |k: &str| csp[k].as_array().into_iter().flatten().filter_map(Value::as_str).filter(|d| domain.is_match(d)).collect::<Vec<_>>().join(" ");
    let (res, connect, frames) = (list("resourceDomains"), list("connectDomains"), list("frameDomains"));
    [
        "default-src 'none'".to_string(),
        format!("script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob: {res}"),
        format!("style-src 'self' 'unsafe-inline' {res}"),
        format!("img-src 'self' data: blob: {res}"),
        format!("font-src 'self' data: blob: {res}"),
        format!("media-src 'self' data: blob: {res}"),
        format!("connect-src 'self' {}", if connect.is_empty() { "'none'" } else { &connect }),
        format!("worker-src 'self' blob: {res}"),
        format!("frame-src {}", if frames.is_empty() { "'none'" } else { &frames }),
        "base-uri 'self'".to_string(),
    ]
    .join("; ")
}

// ---------------------------------------------------------------- for the chat

/// The view a tool comes with, if any (looked up in the MCP servers Claude Code uses in
/// this folder): { server, tool, uri }.
pub fn app_for(app: &AppHandle, tool: &str, folder: &str) -> Option<Value> {
    let (server, name) = parse_tool_name(tool)?;
    // (can't reach the server: no view, the chat still works)
    let tools = tools_of(app, &server, folder).ok()?;
    let uri = ui_of(tools.iter().find(|t| t["name"] == name.as_str())?)?;
    Some(json!({ "server": server, "tool": name, "uri": uri }))
}

/// Fetch (once) the app's page and give the address the chat loads it from.
fn page_for(app: &AppHandle, server: &str, uri: &str, folder: &str) -> Result<Value, RpcError> {
    let key = page_key(server, uri);
    if !apps(app, |a| a.pages.contains_key(&key)) {
        let client = client_for(app, server, folder).ok_or_else(|| RpcError::new(format!("I can't reach the {server} server myself.")))?;
        let res = request(&client, "resources/read", json!({ "uri": uri }))?;
        let content = res["contents"].as_array().into_iter().flatten().find(|c| c["text"].is_string()).cloned().unwrap_or(Value::Null);
        let html = content["text"].as_str().unwrap_or("");
        if html.is_empty() {
            return Err(RpcError::new("The app has no page to show."));
        }
        let meta = if content["_meta"]["ui"].is_object() { content["_meta"]["ui"].clone() } else { json!({}) };
        apps(app, |a| a.pages.insert(key.clone(), Page { html: html.to_string(), meta }));
    }
    let meta = apps(app, |a| a.pages.get(&key).map(|p| p.meta.clone())).unwrap_or_default();
    let permissions = if meta["permissions"].is_object() { meta["permissions"].clone() } else { json!({}) };
    Ok(json!({ "url": format!("{PAGE_BASE}{key}/"), "prefersBorder": meta["prefersBorder"] != false, "permissions": permissions }))
}

fn call_from_app(app: &AppHandle, server: &str, method: &str, params: &Value, folder: &str) -> Result<Value, RpcError> {
    if !APP_METHODS.contains(&method) {
        return Err(RpcError::new(format!("{method} isn't allowed")));
    }
    let client = client_for(app, server, folder).ok_or_else(|| RpcError::new(format!("I can't reach the {server} server myself.")))?;
    if method == "tools/call" && !tools_of(app, server, folder)?.iter().any(|t| t["name"] == params["name"]) {
        return Err(RpcError::new(format!("{server} has no tool called {}", text(&params["name"]))));
    }
    request(&client, method, if params.is_null() { json!({}) } else { params.clone() })
}

/// The cbot-app protocol: a fetched app page with its own CSP.
pub fn serve_page(app: &AppHandle, uri: &tauri::http::Uri) -> tauri::http::Response<Vec<u8>> {
    let key = uri.path().trim_start_matches('/').split('/').next().unwrap_or("").to_string();
    let page = apps(app, |a| a.pages.get(&key).map(|p| (p.html.clone(), csp_for(&p.meta))));
    let Some((html, csp)) = page else {
        return tauri::http::Response::builder().status(404).body(b"Not found".to_vec()).unwrap_or_default();
    };
    tauri::http::Response::builder()
        .header("Content-Type", "text/html; charset=utf-8")
        .header("Content-Security-Policy", csp)
        .body(html.into_bytes())
        .unwrap_or_default()
}

// ---------------------------------------------------------------- the big window

/// An MCP tool's view, big, in a window of its own (the view's fullscreen mode). One window
/// per tool call: asking again brings it to the front.
fn open_window(app: &AppHandle, robot_id: &str, view: &Value) -> bool {
    if robot_id.is_empty() || text(&view["server"]).is_empty() || text(&view["uri"]).is_empty() {
        return false;
    }
    let id = text(&view["id"]);
    let open = apps(app, |a| a.windows.iter().find(|(_, (_, v))| v["id"] == id.as_str()).map(|(l, _)| l.clone()));
    if let Some(label) = open
        && let Some(w) = app.get_webview_window(&label)
    {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return true;
    }
    static COUNT: AtomicU64 = AtomicU64::new(0);
    let label = format!("appview-{}", COUNT.fetch_add(1, Ordering::Relaxed) + 1);
    let title = text(&view["title"]);
    let kept = json!({ "id": id, "server": text(&view["server"]), "tool": text(&view["tool"]), "uri": text(&view["uri"]), "title": title, "input": view["input"], "result": view["result"] });
    apps(app, |a| a.windows.insert(label.clone(), (robot_id.to_string(), kept)));
    let app = app.clone();
    // (off this thread: building a window waits on the main thread)
    thread::spawn(move || {
        let p = win::primary_monitor();
        let (w, h) = ((p.work.w as f64 / p.scale * 0.85).round().min(1400.0), (p.work.h as f64 / p.scale * 0.85).round().min(950.0));
        let built = views::builder(&app, &label, "appview", &[])
            .title(if title.is_empty() { "Tool view" } else { &title })
            .inner_size(w, h)
            .center()
            .background_color(tauri::window::Color(0xff, 0xff, 0xff, 0xff))
            .build();
        match built {
            Ok(win) => {
                let (app2, label2) = (app.clone(), label.clone());
                win.on_window_event(move |e| {
                    if let tauri::WindowEvent::Destroyed = e {
                        apps(&app2, |a| a.windows.remove(&label2));
                    }
                });
            }
            Err(err) => {
                eprintln!("[mcp apps] couldn't open {label}: {err}");
                apps(&app, |a| a.windows.remove(&label));
            }
        }
    });
    true
}

/// The folder of the robot a window belongs to (its own, or the one a big view came from).
fn folder_of(app: &AppHandle, label: &str) -> String {
    let id = robots::id_of(label).map(str::to_string).or_else(|| apps(app, |a| a.windows.get(label).map(|(r, _)| r.clone())));
    let Some(id) = id else { return String::new() };
    with(app, |st| st.store.get(&id).and_then(|c| c["folder"].as_str().map(str::to_string))).unwrap_or_default()
}

// ---------------------------------------------------------------- commands
// (from a robot's chat, or a view's own window: folder_of knows whose folder either is in)

/// The view a tool comes with, if it has one.
#[tauri::command(async)]
pub fn robot_app_view(app: AppHandle, window: tauri::WebviewWindow, tool_name: String) -> Value {
    app_for(&app, &tool_name, &folder_of(&app, window.label())).unwrap_or(Value::Null)
}

/// A view's page, from its server.
#[tauri::command(async)]
pub fn robot_app_page(app: AppHandle, window: tauri::WebviewWindow, server: String, uri: String) -> Value {
    match page_for(&app, &server, &uri, &folder_of(&app, window.label())) {
        Ok(mut page) => {
            page["ok"] = json!(true);
            page
        }
        Err(e) => json!({ "ok": false, "error": e.message }),
    }
}

/// A view's own request to its server (tools/call, resources/read…).
#[tauri::command(async)]
pub fn robot_app_call(app: AppHandle, window: tauri::WebviewWindow, server: String, method: String, params: Option<Value>) -> Value {
    match call_from_app(&app, &server, &method, &params.unwrap_or_default(), &folder_of(&app, window.label())) {
        Ok(result) => json!({ "ok": true, "result": result }),
        Err(e) => json!({ "ok": false, "error": e.message, "code": e.code }),
    }
}

/// A view, big in a window of its own.
#[tauri::command(async)]
pub fn robot_app_window(app: AppHandle, window: tauri::WebviewWindow, view: Value) -> bool {
    robots::id_of(window.label()).is_some_and(|id| open_window(&app, id, &view))
}

/// What a view window shows.
#[tauri::command(async)]
pub fn appview_init(app: AppHandle, window: tauri::WebviewWindow) -> Value {
    apps(&app, |a| a.windows.get(window.label()).map(|(_, v)| v.clone())).unwrap_or(Value::Null)
}

pub fn setup(app: &AppHandle) {
    app.manage(Mutex::new(Apps::default()));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_names_split_into_server_and_tool() {
        assert_eq!(parse_tool_name("mcp__claude_ai_Excalidraw__create_view"), Some(("claude_ai_Excalidraw".into(), "create_view".into())));
        assert_eq!(parse_tool_name("mcp__a__b__c"), Some(("a".into(), "b__c".into())));
        assert_eq!(parse_tool_name("Read"), None);
        assert_eq!(safe_name("my server.v2"), "my_server_v2");
    }

    #[test]
    fn a_server_is_found_in_the_project_then_mcp_json_then_the_user() {
        let user = json!({
            "mcpServers": { "draw it": { "type": "http", "url": "https://u.example/mcp", "headers": { "X-Key": "1" } }, "old": { "type": "sse", "url": "https://s.example" } },
            "projects": { "C:/work/app": { "mcpServers": { "proj": { "url": "https://p.example/mcp" } } } },
        });
        let shared = json!({ "mcpServers": { "shared": { "url": "https://s2.example/mcp" } } });
        assert_eq!(configured_server("proj", "C:\\work\\app", &user, &shared).unwrap().url, "https://p.example/mcp");
        assert_eq!(configured_server("shared", "C:\\work\\app", &user, &shared).unwrap().url, "https://s2.example/mcp");
        let u = configured_server("draw_it", "C:\\other", &user, &Value::Null).unwrap();
        assert_eq!((u.url.as_str(), u.headers), ("https://u.example/mcp", vec![("X-Key".to_string(), "1".to_string())]));
        assert!(configured_server("old", "", &user, &Value::Null).is_none()); // (SSE servers aren't spoken to)
        assert!(configured_server("nope", "", &user, &Value::Null).is_none());
    }

    #[test]
    fn replies_come_as_json_or_an_event_stream() {
        let body = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"tools\":[]}}\n\n";
        let msgs = messages_in(body, true).unwrap();
        assert_eq!(reply_to(msgs, &json!(2)).unwrap(), json!({ "tools": [] }));
        let msgs = messages_in(r#"{"jsonrpc":"2.0","id":3,"error":{"code":-32602,"message":"bad"}}"#, false).unwrap();
        let e = reply_to(msgs, &json!(3)).unwrap_err();
        assert_eq!((e.message.as_str(), e.code), ("bad", Some(-32602)));
        assert_eq!(reply_to(vec![], &json!(1)).unwrap_err().message, "No answer from the MCP server");
    }

    #[test]
    fn a_page_gets_only_the_domains_it_declares() {
        let csp = csp_for(&json!({ "csp": { "resourceDomains": ["https://cdn.example.com", "http://bad.example", "javascript:x"], "connectDomains": ["https://api.example.com:8443"] } }));
        assert!(csp.starts_with("default-src 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob: https://cdn.example.com; "));
        assert!(csp.contains("connect-src 'self' https://api.example.com:8443; "));
        assert!(csp.contains("frame-src 'none'; base-uri 'self'"));
        assert!(!csp.contains("bad.example"));
        assert!(csp_for(&json!({})).contains("connect-src 'self' 'none'"));
    }

    #[test]
    fn views_are_read_from_the_tool_meta() {
        assert_eq!(ui_of(&json!({ "_meta": { "ui": { "resourceUri": "ui://a" } } })).as_deref(), Some("ui://a"));
        assert_eq!(ui_of(&json!({ "_meta": { "ui/resourceUri": "ui://b" } })).as_deref(), Some("ui://b"));
        assert_eq!(ui_of(&json!({ "name": "x" })), None);
        assert_ne!(page_key("s", "ui://a"), page_key("s", "ui://b"));
        assert_eq!(page_key("s", "ui://a"), page_key("s", "ui://a"));
    }
}
