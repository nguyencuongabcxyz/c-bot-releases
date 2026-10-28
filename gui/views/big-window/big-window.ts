// The big window for an MCP tool's view: the same page as in the chat bubble, in
// its fullscreen mode (where Excalidraw lets you edit). Leaving fullscreen closes it.
import { $ } from '@/lib/dom';
import { McpAppHost } from '@/features/mcp/app-host';
import { showView } from '@/lib/page';
import markup from './big-window.html?raw';
import './big-window.css';

import * as ipc from '@/ipc';

showView(markup, { title: 'Tool view' });

(async () => {
  const note = $('#note');
  const view = await ipc.appviewInit();
  if (!view) return window.close();
  document.title = view.title || 'Tool view';
  const page = await ipc.robotAppPage(view.server, view.uri);
  if (!page.ok) {
    note.textContent = `Couldn't load the view: ${page.error}`;
    return;
  }
  const frame = McpAppHost.frameFor(page, document.title);
  document.body.appendChild(frame);
  frame.src = page.url;
  const host = McpAppHost.create({
    frame,
    ...view,
    displayMode: 'fullscreen',
    onReady: () => (note.hidden = true),
    onDisplayMode: (mode) => {
      if (mode === 'inline') setTimeout(() => window.close(), 50);
      return mode;
    },
  });
  addEventListener('resize', () => host.resized());
})();
