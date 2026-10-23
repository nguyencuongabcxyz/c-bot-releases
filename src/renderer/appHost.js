/* global cbot */
// MCP Apps host. An MCP tool's own page (its "view", e.g. an Excalidraw drawing)
// runs in a sandboxed frame on its own origin and talks to us over postMessage
// (JSON-RPC). We hand it the tool's input and result, and pass its own requests
// (tools/call, resources/read…) on to its server through main. Shared by the chat
// bubbles and the big view window.
window.McpAppHost = (() => {
  const hosts = new WeakMap(); // frame window -> host

  window.addEventListener('message', (e) => {
    const host = hosts.get(e.source);
    const msg = e.data;
    if (!host || !msg || msg.jsonrpc !== '2.0' || !msg.method) return;
    if (msg.id !== undefined) host.request(msg);
    else host.notice(msg);
  });

  /**
   * opts: { frame (already in the page), id, server, tool, input, result,
   *         displayMode ('inline' | 'fullscreen'), maxHeight,
   *         onReady(), onSize(height), onDisplayMode(mode) -> the mode now in use, onMessage(text) }
   */
  function create(opts) {
    const { frame } = opts;
    let ready = false;
    let result = opts.result;
    let mode = opts.displayMode || 'inline';
    const post = (msg) => frame.contentWindow?.postMessage({ jsonrpc: '2.0', ...msg }, '*');
    const dimensions = () =>
      mode === 'fullscreen'
        ? { width: frame.clientWidth, height: frame.clientHeight }
        : { width: frame.clientWidth || 520, maxHeight: opts.maxHeight };
    const context = () => ({
      theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
      displayMode: mode,
      availableDisplayModes: ['inline', 'fullscreen'],
      containerDimensions: dimensions(),
      locale: navigator.language,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      platform: 'desktop',
      deviceCapabilities: { touch: false, hover: true },
      toolInfo: { id: opts.id, tool: { name: opts.tool, inputSchema: { type: 'object' } } },
    });

    const host = {
      async request({ id, method, params = {} }) {
        const reply = (res) => post({ id, result: res });
        const fail = (message, code = -32603) => post({ id, error: { code, message } });
        switch (method) {
          case 'ui/initialize':
            return reply({
              protocolVersion: params.protocolVersion || '2025-11-21',
              hostInfo: { name: 'C-Bot', version: '0.1.0' },
              hostCapabilities: { openLinks: {}, serverTools: {}, serverResources: {}, logging: {}, updateModelContext: {}, message: {} },
              hostContext: context(),
            });
          case 'ping':
          case 'ui/update-model-context':
            return reply({});
          case 'ui/open-link':
            cbot.invoke('robot:open-link', params.url);
            return reply({});
          case 'ui/request-display-mode':
            mode = (await opts.onDisplayMode?.(params.mode)) || mode;
            return reply({ mode });
          case 'ui/message': {
            const text = (params.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
            if (text) opts.onMessage?.(text);
            return reply({});
          }
          default:
            if (/^(tools|resources|prompts)\//.test(method)) {
              const res = await cbot.invoke('robot:app-call', opts.server, method, params);
              return res.ok ? reply(res.result) : fail(res.error, res.code || -32603);
            }
            return fail(`${method} isn't supported here`, -32601);
        }
      },

      notice({ method, params = {} }) {
        if (method === 'ui/notifications/initialized') {
          ready = true;
          opts.onReady?.();
          // views start out inline; tell a big-window one it's fullscreen (Excalidraw then turns editable)
          if (mode !== 'inline') post({ method: 'ui/notifications/host-context-changed', params: { displayMode: mode, containerDimensions: dimensions() } });
          if (opts.input) post({ method: 'ui/notifications/tool-input', params: { arguments: opts.input } });
          if (result) post({ method: 'ui/notifications/tool-result', params: result });
        } else if (method === 'ui/notifications/size-changed' && params.height) {
          opts.onSize?.(Math.ceil(params.height));
        }
      },

      setResult(res) {
        result = res;
        if (ready) post({ method: 'ui/notifications/tool-result', params: res });
      },

      // the frame changed size (the big window was resized)
      resized() {
        if (ready) post({ method: 'ui/notifications/host-context-changed', params: { containerDimensions: dimensions() } });
      },

      get ready() {
        return ready;
      },
    };
    hosts.set(frame.contentWindow, host);
    return host;
  }

  // a sandboxed frame for an app page ({ url, permissions } from robot:app-page)
  function frameFor(page, title) {
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-downloads');
    if (page.permissions?.clipboardWrite) frame.setAttribute('allow', 'clipboard-write');
    frame.title = title;
    return frame;
  }

  return { create, frameFor };
})();
