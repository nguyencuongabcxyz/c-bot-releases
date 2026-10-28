// Local files in answers. Pictures Claude made or points at are shown (through
// main's cbot-file: protocol), and file links or `C:\…\file.ext` paths open the file.
// (robot.ts calls createChatMarkdown with its hub.)
import type { DeskActivityApi } from '@/views/robot/life/desk';
import type { HelpersApi } from '../agents';
import type { RobotState } from '@/views/robot/types';
import { dressCode } from './code';
import * as ipc from '@/ipc';
import { markdown } from '@/lib/markdown';
import { samePath } from '@/lib/text';

/** What it uses of the robot window (robot.ts's hub). */
export type ChatMarkdownNeeds = {
  readonly openFileView: HelpersApi['openFileView'];
  readonly showPop: DeskActivityApi['showPop'];
  readonly state: RobotState;
};

export function createChatMarkdown(r: ChatMarkdownNeeds) {
  // Local files in answers. Pictures Claude made or points at are shown (through
  // main's cbot-file: protocol), and file links or `C:\…\file.ext` paths open the file.
  const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|avif|svg)$/i;
  // an absolute local path from "C:\…", "/…", "\\server\…", "file:///…", or a path inside the robot's folder
  function localPath(href: string | null | undefined) {
    let p = String(href || '').trim();
    if (!p || p.startsWith('#')) return null;
    if (/^file:\/\//i.test(p)) {
      try {
        p = decodeURIComponent(new URL(p).pathname).replace(/^\/([a-zA-Z]:)/, '$1');
      } catch {
        return null;
      }
    } else if (/^[a-z][a-z0-9+.-]*:/i.test(p) && !/^[a-zA-Z]:[\\/]/.test(p)) {
      return null; // a web link or another scheme
    } else if (!/^([a-zA-Z]:[\\/]|\/|\\\\)/.test(p)) {
      const folder = r.state.character?.folder;
      if (!folder || /^[a-z]+\.[a-z]{2,}\//i.test(p)) return null; // "example.com/…" is not a file
      p = `${folder.replace(/[\\/]+$/, '')}\\${p.replace(/^\.[\\/]/, '')}`;
    }
    return p;
  }
  // (under Tauri the protocol is served from http://cbot-file.localhost/: its bridge says so)
  const FILE_URL = ipc.fileUrl;
  const imageUrl = (p: string, v: string | number = '') =>
    `${FILE_URL}img/?path=${encodeURIComponent(p)}${v ? `&v=${v}` : ''}`;
  const openUrl = (p: string) => `${FILE_URL}open/?path=${encodeURIComponent(p)}`;
  const chatMd = markdown({
    extensions: [
      {
        walkTokens(t) {
          if (t.type !== 'image' && t.type !== 'link') return;
          const p = localPath(t.href);
          if (!p) return;
          t.href = t.type === 'image' && IMAGE_EXT.test(p) ? imageUrl(p) : openUrl(p);
        },
      },
    ],
    purify: { ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|cbot-file):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i },
  });
  const ABS_FILE = /^(?:[a-zA-Z]:[\\/]|\\\\|\/(?:Users|home|tmp|var|opt|mnt)\/)[^\n<>"|?*]*\.[A-Za-z0-9]{1,8}$/;
  function md(text: string) {
    const frag = chatMd.fragment(text);
    // `C:\…\rocket.svg` in code: clickable, and pictures show right under it
    for (const code of frag.querySelectorAll('code')) {
      if (code.closest('pre')) continue;
      const p = code.textContent.trim().replace(/^["']|["']$/g, '');
      if (!ABS_FILE.test(p)) continue;
      code.classList.add('file-path');
      code.dataset.open = p;
      code.title = 'Open this file';
      if (!IMAGE_EXT.test(p)) continue;
      const img = document.createElement('img');
      img.className = 'local-img';
      img.src = imageUrl(p);
      img.alt = p.split(/[\\/]/).pop() ?? '';
      img.dataset.open = p;
      (code.closest('p, li') || code).after(img);
    }
    for (const img of frag.querySelectorAll<HTMLImageElement>(`img[src^="${FILE_URL}img/"]`)) {
      img.classList.add('local-img');
      const path = new URL(img.src).searchParams.get('path'); // (our picture links carry their path)
      if (path !== null) img.dataset.open = path;
    }
    const box = document.createElement('div');
    box.appendChild(frag);
    dressCode(box); // (highlighted, with a Copy button)
    return box.innerHTML;
  }

  // a code block's Copy button (code.ts)
  document.addEventListener('click', (e) => {
    const btn = (e.target as Element).closest<HTMLButtonElement>('.code-copy');
    if (!btn) return;
    const code = btn.closest('.codeblock')?.querySelector('pre')?.textContent ?? '';
    navigator.clipboard.writeText(code).then(
      () => {
        btn.textContent = 'Copied';
        btn.classList.add('done');
        setTimeout(() => {
          btn.textContent = 'Copy';
          btn.classList.remove('done');
        }, 1400);
      },
      () => {},
    );
  });

  // a picture its file card already shows isn't shown again under its path in the text
  function dedupePics(el: HTMLElement) {
    const shown = new Set(
      [...el.querySelectorAll<HTMLImageElement>('.d-preview img')].map((i) => samePath(i.dataset.open)),
    );
    if (!shown.size) return;
    for (const img of el.querySelectorAll<HTMLImageElement>('img.local-img')) {
      if (!img.closest('.d-preview') && shown.has(samePath(img.dataset.open))) img.remove();
    }
  }

  // clicking a local file (a link, a path, a picture) shows it in the chat; Ctrl+click opens
  // it in its app (programs are only shown in their folder)
  const openInApp = (p: string) => ipc.robotOpenFile(p).then((res) => res && !res.ok && r.showPop(res.error, 2400));
  document.addEventListener('click', (e) => {
    // (a click lands on an element; the link's href is read only when it has no data-open)
    const link = (e.target as Element).closest<HTMLAnchorElement>(`a[href^="${FILE_URL}open/"], [data-open]`);
    if (!link) {
      // a web link opens in the browser (the webview won't open a new window for target=_blank)
      const web = (e.target as Element).closest<HTMLAnchorElement>('a[href^="http://"], a[href^="https://"]');
      if (web && !web.href.startsWith(FILE_URL)) {
        e.preventDefault();
        ipc.robotOpenLink(web.href);
      }
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const p = link.dataset.open || new URL(link.href).searchParams.get('path'); // (our file links carry their path)
    if (!p) return;
    if (e.ctrlKey || e.metaKey) openInApp(p);
    else r.openFileView(p, { start: link.dataset.view });
  });
  // a picture that isn't there (yet, or anymore) just disappears
  document.addEventListener(
    'error',
    (e) => (e.target as Element).matches?.('img.local-img') && (e.target as Element).remove(),
    true,
  );
  return { FILE_URL, IMAGE_EXT, dedupePics, imageUrl, md, openInApp };
}
export type ChatMarkdownApi = ReturnType<typeof createChatMarkdown>;
