// Some MCP tools (Excalidraw's create_view…) come with their own page that shows
// what they did: an MCP App, hosted by McpAppHost (mcp/app-host.ts). Its fullscreen
// button opens the same view in a big window of its own.
// (robot.ts calls createAppViews with its hub.)
import { $ } from '@/lib/dom';
import { clamp } from '@/lib/math';
import type { ComposerApi } from '@/features/chat/composer/composer';
import type { LifeCycleApi } from '@/views/robot/life/lifecycle';
import type { AppHost } from '@/views/robot/types';
import * as ipc from '@/ipc';
import { McpAppHost } from './app-host';
import type { AppCall, AppViewCall } from '@/types/model';
import { Icon } from '@/icons/icons';

/** What it uses of the robot window (robot.ts's hub). */
export type AppViewsNeeds = {
  readonly autosize: ComposerApi['autosize'];
  readonly input: HTMLTextAreaElement;
  readonly openChat: LifeCycleApi['openChat'];
};

export function createAppViews(r: AppViewsNeeds) {
  // Some MCP tools (Excalidraw's create_view…) come with their own page that shows
  // what they did: an MCP App, hosted by McpAppHost (mcp/app-host.ts). Its fullscreen
  // button opens the same view in a big window of its own.
  const APP_MAX_H = 560;
  const appsById = new Map<string, AppHost>(); // tool call id -> host (for results that arrive later)
  const serverLabel = (s: string) => s.replace(/^claude_ai_/, '').replace(/_/g, ' ');

  // a: { id, input, result } plus either the view ({ server, tool, uri }) or the tool's name to look it up
  function appCard(a: (AppCall & { uri?: undefined }) | AppViewCall) {
    const card = document.createElement('div');
    card.className = 'app-card';
    card.innerHTML = `<div class="app-head"><span class="app-title"></span><span class="app-state">loading…</span><button class="app-big" type="button" title="Open in a big window" hidden>${Icon('expand', 'sm')}</button></div>`;
    const title = $<HTMLElement>('.app-title', card);
    const status = $<HTMLElement>('.app-state', card);
    const bigBtn = $<HTMLButtonElement>('.app-big', card);
    Icon.text(title, '🧩 Tool view');
    (async () => {
      const view = a.uri ? a : await ipc.robotAppView((a as AppCall).name); // (no view: kept with its answer, with its tool's name)
      if (!view) return card.remove(); // no view after all (or its server is out of reach)
      Icon.text(title, `🧩 ${serverLabel(view.server)} · ${view.tool}`);
      const page = await ipc.robotAppPage(view.server, view.uri);
      if (!page.ok) {
        status.textContent = `couldn't load: ${page.error}`;
        return;
      }
      const frame = McpAppHost.frameFor(page, title.textContent);
      frame.style.height = '360px';
      card.classList.toggle('bordered', page.prefersBorder);
      card.appendChild(frame);
      frame.src = page.url;
      const call = { id: a.id, server: view.server, tool: view.tool, uri: view.uri, input: a.input, result: a.result };
      const openBig = () => ipc.robotAppWindow({ ...call, title: title.textContent.replace(/^🧩 /, '') });
      const host = McpAppHost.create({
        // (its call goes on it below)
        frame,
        ...call,
        displayMode: 'inline',
        maxHeight: APP_MAX_H,
        onReady: () => {
          status.textContent = '';
          bigBtn.hidden = false;
        },
        onSize: (h) => (frame.style.height = `${clamp(h, 80, APP_MAX_H)}px`),
        // its own fullscreen button: the view opens big in its own window, this one stays inline
        onDisplayMode: (mode) => {
          if (mode === 'fullscreen') openBig();
          return 'inline';
        },
        // the view wants to say something in the chat: put it in the box, you send it
        onMessage: (text) => {
          r.openChat();
          r.input.value = text;
          r.autosize();
          r.input.focus();
        },
      }) as AppHost;
      bigBtn.addEventListener('click', openBig);
      host.call = call;
      appsById.set(a.id, host);
      const oldest = appsById.keys().next().value; // (a map keeps the order they came in)
      if (appsById.size > 60 && oldest !== undefined) appsById.delete(oldest);
      setTimeout(() => {
        if (!host.ready) status.textContent = "didn't start";
      }, 20000);
    })();
    return card;
  }

  function appResult(id: string, result: unknown) {
    const host = appsById.get(id);
    if (!host) return;
    host.call.result = result; // for the big window
    host.setResult(result);
  }

  function asideChip(text: string) {
    const chip = document.createElement('span');
    chip.className = 'tool aside';
    Icon.text(chip, `💭 ${text}`);
    return chip;
  }
  return { appCard, appResult, asideChip, serverLabel };
}
export type AppViewsApi = ReturnType<typeof createAppViews>;
