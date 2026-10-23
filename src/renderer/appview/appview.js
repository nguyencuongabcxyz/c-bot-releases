/* global cbot, McpAppHost */
// The big window for an MCP tool's view: the same page as in the chat bubble, in
// its fullscreen mode (where Excalidraw lets you edit). Leaving fullscreen closes it.
(async () => {
  const note = document.getElementById('note');
  const view = await cbot.invoke('appview:init');
  if (!view) return window.close();
  document.title = view.title || 'Tool view';
  const page = await cbot.invoke('robot:app-page', view.server, view.uri);
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
