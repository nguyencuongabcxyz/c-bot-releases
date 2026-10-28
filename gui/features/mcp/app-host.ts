// MCP Apps host. An MCP tool's own page (its "view", e.g. an Excalidraw drawing)
// runs in a sandboxed frame on its own origin and talks to us over postMessage
// (JSON-RPC). We hand it the tool's input and result, and pass its own requests
// (tools/call, resources/read…) on to its server through main. Shared by the chat
// bubbles and the big view window.
import type { AppPage } from '@/types/model';

import * as ipc from '@/ipc';

/** What a view sends us (MCP Apps: JSON-RPC 2.0); a request has an id, a notification none. */
type RpcMessage = { jsonrpc: '2.0'; id?: string | number; method: string; params?: RpcParams };
/** The params of the requests and notifications we answer. */
type RpcParams = {
  protocolVersion?: string;
  url?: string;
  mode?: string;
  content?: { type: string; text?: string }[];
  height?: number;
  [more: string]: unknown;
};

export type McpAppHostOptions = {
  frame: HTMLIFrameElement; // (already in the page)
  id: string;
  server: string;
  tool: string;
  input?: unknown;
  result?: unknown;
  displayMode?: 'inline' | 'fullscreen';
  maxHeight?: number;
  onReady?(): void;
  onSize?(height: number): void;
  onDisplayMode?(mode: string | undefined): string | undefined | Promise<string | undefined>; // -> the mode now in use
  onMessage?(text: string): void;
};

/** A view's host: it answers the view, and passes the tool's result on when it comes. */
export type McpAppHostHandle = {
  request(msg: RpcMessage): Promise<void>;
  notice(msg: RpcMessage): void;
  setResult(res: unknown): void;
  resized(): void;
  readonly ready: boolean;
};

export const McpAppHost = (() => {
  const hosts = new WeakMap<object, McpAppHostHandle>(); // frame window -> host

  window.addEventListener('message', (e) => {
    const host = e.source && hosts.get(e.source);
    const msg: RpcMessage | null | undefined = e.data; // (checked here before it's used)
    if (!host || !msg || msg.jsonrpc !== '2.0' || !msg.method) return;
    if (msg.id !== undefined) host.request(msg);
    else host.notice(msg);
  });

  /**
   * opts: { frame (already in the page), id, server, tool, input, result,
   *         displayMode ('inline' | 'fullscreen'), maxHeight,
   *         onReady(), onSize(height), onDisplayMode(mode) -> the mode now in use, onMessage(text) }
   */
  function create(opts: McpAppHostOptions) {
    const { frame } = opts;
    let ready = false;
    let result = opts.result;
    let mode: string = opts.displayMode || 'inline';
    const post = (msg: object) => frame.contentWindow?.postMessage({ jsonrpc: '2.0', ...msg }, '*');
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

    const host: McpAppHostHandle = {
      async request({ id, method, params = {} }) {
        const reply = (res: unknown) => post({ id, result: res });
        const fail = (message: string, code = -32603) => post({ id, error: { code, message } });
        switch (method) {
          case 'ui/initialize':
            return reply({
              protocolVersion: params.protocolVersion || '2025-11-21',
              hostInfo: { name: 'C-Bot', version: '0.1.0' },
              hostCapabilities: {
                openLinks: {},
                serverTools: {},
                serverResources: {},
                logging: {},
                updateModelContext: {},
                message: {},
              },
              hostContext: context(),
            });
          case 'ping':
          case 'ui/update-model-context':
            return reply({});
          case 'ui/open-link':
            ipc.robotOpenLink(params.url);
            return reply({});
          case 'ui/request-display-mode':
            mode = (await opts.onDisplayMode?.(params.mode)) || mode;
            return reply({ mode });
          case 'ui/message': {
            const text = (params.content || [])
              .filter((c) => c.type === 'text')
              .map((c) => c.text)
              .join('\n');
            if (text) opts.onMessage?.(text);
            return reply({});
          }
          default:
            if (/^(tools|resources|prompts)\//.test(method)) {
              const res = await ipc.robotAppCall(opts.server, method, params);
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
          if (mode !== 'inline')
            post({
              method: 'ui/notifications/host-context-changed',
              params: { displayMode: mode, containerDimensions: dimensions() },
            });
          if (opts.input) post({ method: 'ui/notifications/tool-input', params: { arguments: opts.input } });
          if (result) post({ method: 'ui/notifications/tool-result', params: result });
        } else if (method === 'ui/notifications/size-changed' && params.height) {
          opts.onSize?.(Math.ceil(params.height));
        }
      },

      setResult(res: unknown) {
        result = res;
        if (ready) post({ method: 'ui/notifications/tool-result', params: res });
      },

      // the frame changed size (the big window was resized)
      resized() {
        if (ready)
          post({ method: 'ui/notifications/host-context-changed', params: { containerDimensions: dimensions() } });
      },

      get ready() {
        return ready;
      },
    };
    // (the frame is in the page: it has its window; a WeakMap would throw on null anyway)
    if (!frame.contentWindow) throw new Error('The app frame has no window: it must be in the page first.');
    hosts.set(frame.contentWindow, host);
    return host;
  }

  // a sandboxed frame for an app page ({ url, permissions } from robot:app-page)
  function frameFor(page: AppPage, title: string) {
    const frame = document.createElement('iframe');
    frame.setAttribute(
      'sandbox',
      'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-downloads',
    );
    if (page.permissions?.clipboardWrite) frame.setAttribute('allow', 'clipboard-write');
    frame.title = title;
    return frame;
  }

  return { create, frameFor };
})();
