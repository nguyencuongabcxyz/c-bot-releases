//! A tiny MCP client: just enough of the protocol (over HTTP) to read an app's page and to pass on the calls it makes.

use super::*;

#[derive(Debug)]
pub(super) struct RpcError {
    pub(super) message: String,
    pub(super) code: Option<i64>,
}

impl RpcError {
    pub(super) fn new(message: impl Into<String>) -> RpcError {
        RpcError {
            message: message.into(),
            code: None,
        }
    }
}

/// Runs the HTTP off the async runtime the IPC calls come on (reqwest's blocking client
/// mustn't be used from inside one).
pub(super) fn off_runtime<T: Send>(f: impl FnOnce() -> T + Send) -> Option<T> {
    thread::scope(|s| s.spawn(f).join().ok())
}

pub(super) fn http() -> Option<&'static reqwest::blocking::Client> {
    static CLIENT: LazyLock<Option<reqwest::blocking::Client>> = LazyLock::new(|| {
        let _ = rustls::crypto::ring::default_provider().install_default(); // (as the updater does)
        reqwest::blocking::Client::builder()
            .timeout(HTTP_TIMEOUT)
            .build()
            .map_err(|e| log::warn!("no HTTP client: {e}"))
            .ok()
    });
    CLIENT.as_ref()
}

/// The JSON-RPC messages in a reply: one JSON body, or an event stream's data lines.
pub(super) fn messages_in(body: &str, event_stream: bool) -> Result<Vec<Value>, RpcError> {
    let parse = |t: &str| {
        serde_json::from_str::<Value>(t.trim()).map_err(|e| {
            RpcError::new(format!(
                "The MCP server sent back something unreadable ({e})"
            ))
        })
    };
    if event_stream {
        body.lines()
            .filter_map(|l| l.strip_prefix("data:"))
            .map(parse)
            .collect()
    } else {
        Ok(vec![parse(body)?])
    }
}

/// The answer to request `id` among them.
pub(super) fn reply_to(messages: Vec<Value>, id: &Value) -> Result<Value, RpcError> {
    let reply = messages
        .into_iter()
        .find(|m| &m["id"] == id)
        .ok_or_else(|| RpcError::new("No answer from the MCP server"))?;
    if !reply["error"].is_null() {
        let e = &reply["error"];
        return Err(RpcError {
            message: e["message"]
                .as_str()
                .filter(|m| !m.is_empty())
                .unwrap_or("MCP error")
                .to_string(),
            code: e["code"].as_i64(),
        });
    }
    Ok(reply.get("result").cloned().unwrap_or(Value::Null))
}

/// A streamable-HTTP MCP client: initialize once, then JSON-RPC requests.
pub(super) struct McpHttp {
    pub(super) cfg: ServerCfg,
    pub(super) session_id: Option<String>,
    pub(super) next_id: u64,
    pub(super) ready: bool,
}

impl McpHttp {
    pub(super) fn post(&mut self, body: &Value) -> Result<Value, RpcError> {
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
        let res = req
            .body(body.to_string())
            .send()
            .map_err(|e| RpcError::new(format!("{} isn't reachable ({e})", self.cfg.url)))?;
        if !res.status().is_success() {
            return Err(RpcError::new(format!(
                "{} answered {}",
                self.cfg.url,
                res.status().as_u16()
            )));
        }
        if let Some(sid) = res
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
        {
            self.session_id = Some(sid.to_string());
        }
        if body.get("id").is_none() {
            return Ok(Value::Null); // a notification
        }
        let stream = res
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|t| t.contains("text/event-stream"));
        let text = res
            .text()
            .map_err(|e| RpcError::new(format!("{} broke off ({e})", self.cfg.url)))?;
        reply_to(messages_in(&text, stream)?, &body["id"])
    }

    pub(super) fn call(&mut self, method: &str, params: Value) -> Result<Value, RpcError> {
        self.next_id += 1;
        let id = self.next_id;
        self.post(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))
    }

    pub(super) fn request(&mut self, method: &str, params: Value) -> Result<Value, RpcError> {
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
