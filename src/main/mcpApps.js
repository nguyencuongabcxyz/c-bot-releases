const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// MCP Apps: some MCP tools come with their own little web page (a "ui://"
// resource) that shows what the tool did — Excalidraw's create_view draws the
// diagram there. Claude Code runs the tool; we fetch that page from the same
// server and host it in the chat, the way Claude Desktop does.

// claude.ai connectors run behind Anthropic's proxy, so we can't reach them the
// way Claude Code does. These ones are public, so we talk to them directly.
const KNOWN_SERVERS = {
  claude_ai_Excalidraw: { url: 'https://mcp.excalidraw.com/mcp' },
};

// Claude Code names tools mcp__<server>__<tool>, with the server name made safe
const safeName = (name) => String(name).replace(/[^a-zA-Z0-9_-]/g, '_');

function parseToolName(name) {
  const m = /^mcp__(.+?)__(.+)$/.exec(name || '');
  return m ? { server: m[1], tool: m[2] } : null;
}

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

// HTTP MCP servers from the user's Claude Code config (user scope, the folder's
// project scope and its .mcp.json). Servers needing OAuth won't answer us; that's fine.
function configuredServer(server, folder) {
  const user = readJson(path.join(os.homedir(), '.claude.json')) || {};
  const project = user.projects?.[folder] || user.projects?.[folder?.replace(/\\/g, '/')] || {};
  const shared = (folder && readJson(path.join(folder, '.mcp.json'))) || {};
  for (const servers of [project.mcpServers, shared.mcpServers, user.mcpServers]) {
    for (const [name, cfg] of Object.entries(servers || {})) {
      if (safeName(name) !== server || !cfg?.url || cfg.type === 'sse') continue;
      return { url: cfg.url, headers: cfg.headers || {} };
    }
  }
  return null;
}

// A tiny streamable-HTTP MCP client: initialize once, then JSON-RPC requests.
class McpHttp {
  constructor({ url, headers = {} }) {
    this.url = url;
    this.headers = headers;
    this.sessionId = null;
    this.nextId = 1;
    this.ready = null;
  }

  async _post(body) {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2025-06-18',
        ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
        ...this.headers,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`${this.url} answered ${res.status}`);
    this.sessionId = res.headers.get('mcp-session-id') || this.sessionId;
    if (body.id === undefined) return null; // a notification
    const text = await res.text();
    const messages = (res.headers.get('content-type') || '').includes('text/event-stream')
      ? text.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5)))
      : [JSON.parse(text)];
    const reply = messages.find((m) => m.id === body.id);
    if (!reply) throw new Error('No answer from the MCP server');
    if (reply.error) throw Object.assign(new Error(reply.error.message || 'MCP error'), { rpc: reply.error });
    return reply.result;
  }

  request(method, params) {
    this.ready ||= this._post({ jsonrpc: '2.0', id: this.nextId++, method: 'initialize', params: {
      protocolVersion: '2025-06-18',
      capabilities: { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } },
      clientInfo: { name: 'C-Bot', version: '0.1.0' },
    } }).then(() => this._post({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    return this.ready
      .catch((err) => {
        this.ready = null; // try again next time
        throw err;
      })
      .then(() => this._post({ jsonrpc: '2.0', id: this.nextId++, method, params }));
  }
}

const clients = new Map(); // server -> McpHttp
const toolLists = new Map(); // server -> Promise<tools[]>
const pages = new Map(); // page key -> { server, uri, html, meta }

function clientFor(server, folder) {
  if (clients.has(server)) return clients.get(server);
  const cfg = KNOWN_SERVERS[server] || configuredServer(server, folder);
  const client = cfg ? new McpHttp(cfg) : null;
  clients.set(server, client);
  return client;
}

function toolsOf(server, folder) {
  const client = clientFor(server, folder);
  if (!client) return Promise.resolve([]);
  if (!toolLists.has(server)) {
    const p = client.request('tools/list', {}).then((r) => r.tools || []);
    p.catch(() => toolLists.delete(server));
    toolLists.set(server, p);
  }
  return toolLists.get(server);
}

const uiOf = (tool) => tool?._meta?.ui?.resourceUri || tool?._meta?.['ui/resourceUri'] || null;
const pageKey = (server, uri) => crypto.createHash('sha1').update(`${server}\n${uri}`).digest('hex').slice(0, 20);

/** Does this Claude Code tool call come with a page to show? → { server, tool, uri } or null */
async function appFor(toolName, folder) {
  const parsed = parseToolName(toolName);
  if (!parsed) return null;
  try {
    const tool = (await toolsOf(parsed.server, folder)).find((t) => t.name === parsed.tool);
    const uri = uiOf(tool);
    return uri ? { server: parsed.server, tool: parsed.tool, uri } : null;
  } catch {
    return null; // can't reach the server: no view, the chat still works
  }
}

/** Fetch (once) the app's page and give the address the chat loads it from. */
async function pageFor(server, uri, folder) {
  const key = pageKey(server, uri);
  if (!pages.get(key)?.html) {
    const client = clientFor(server, folder);
    if (!client) throw new Error(`I can't reach the ${server} server myself.`);
    const res = await client.request('resources/read', { uri });
    const content = (res.contents || []).find((c) => typeof c.text === 'string') || {};
    if (!content.text) throw new Error('The app has no page to show.');
    pages.set(key, { server, uri, html: content.text, meta: content._meta?.ui || {} });
  }
  const { meta } = pages.get(key);
  return { url: `cbot-app://${key}/`, prefersBorder: meta.prefersBorder !== false, permissions: meta.permissions || {} };
}

// The page's Content-Security-Policy, from the domains the app declares (MCP Apps rules).
function cspFor(meta = {}) {
  const csp = meta.csp || {};
  const list = (a) => (Array.isArray(a) ? a.filter((d) => /^https:\/\/[\w.-]+(:\d+)?$/.test(d)).join(' ') : '');
  const res = list(csp.resourceDomains);
  const connect = list(csp.connectDomains);
  const frames = list(csp.frameDomains);
  return [
    "default-src 'none'",
    `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob: ${res}`,
    `style-src 'self' 'unsafe-inline' ${res}`,
    `img-src 'self' data: blob: ${res}`,
    `font-src 'self' data: blob: ${res}`,
    `media-src 'self' data: blob: ${res}`,
    `connect-src 'self' ${connect || "'none'"}`,
    `worker-src 'self' blob: ${res}`,
    `frame-src ${frames || "'none'"}`,
    "base-uri 'self'",
  ].join('; ');
}

/** protocol.handle('cbot-app', …): serve a fetched app page with its own CSP */
function servePage(request) {
  const key = new URL(request.url).hostname;
  const page = pages.get(key);
  if (!page) return new Response('Not found', { status: 404 });
  return new Response(page.html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': cspFor(page.meta) },
  });
}

// What the page may ask its server for, through us.
const APP_METHODS = new Set(['tools/call', 'tools/list', 'resources/read', 'resources/list', 'resources/templates/list', 'prompts/list']);

async function callFromApp(server, method, params, folder) {
  if (!APP_METHODS.has(method)) throw new Error(`${method} isn't allowed`);
  const client = clientFor(server, folder);
  if (!client) throw new Error(`I can't reach the ${server} server myself.`);
  if (method === 'tools/call' && !(await toolsOf(server, folder)).some((t) => t.name === params?.name)) {
    throw new Error(`${server} has no tool called ${params?.name}`);
  }
  return client.request(method, params || {});
}

module.exports = { appFor, pageFor, servePage, callFromApp, parseToolName };
