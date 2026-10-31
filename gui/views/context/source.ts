// A file's text in the Context engine window, beside its definitions and chunks (file.ts): the
// whole file as it is on disk, highlighted, with its line numbers and, in the gutter, a band for
// the chunk each line is in (chunks take turns at two shades, the one picked lit). Only the lines
// in view are drawn, so a long file scrolls as smoothly as a short one. What's picked (a
// definition's lines, a chunk's) is marked and scrolled to; a line clicked says which it is. Its
// other page shows the chunk picked as the index keeps it (its text is what search reads).
import { el } from '@/lib/dom';
import { virtualList } from '@/lib/virtual';
import { highlightFile, highlightLines } from '@/features/chat/reply/code';
import { chunkBands, lines as lineSpan } from '@/features/context/files';
import type { ContextChunk } from '@/types/model';

const LINE = 20;

/** What's picked: its lines, from–to (from 1), and its chunk (its place in the file's chunks). */
export type SourcePick = { from: number; to: number; chunk: number } | null;

export function createSource(onLine: (line: number) => void) {
  const root = el('section', 'src');
  const head = el('div', 'src-head');
  const tabs = el('div', 'src-tabs');
  const [sourceTab, chunkTab] = [el('button', 'src-tab', 'Source'), el('button', 'src-tab', 'Chunk')];
  for (const t of [sourceTab, chunkTab]) t.type = 'button';
  tabs.append(sourceTab, chunkTab);
  const meta = el('span', 'src-meta');
  head.append(tabs, meta);
  const body = el('div', 'src-body');
  const chunkBox = el('pre', 'src-chunk');
  const note = el('p', 'src-note');
  root.append(head, body, chunkBox, note);

  let lines: string[] = [];
  let bands: number[] = [];
  let chunks: ContextChunk[] = [];
  let ext = '';
  let lang: string | null = null;
  let pick: SourcePick = null;
  let mode: 'source' | 'chunk' = 'source';

  const list = virtualList(body, LINE, (i) => {
    const n = i + 1;
    const inPick = pick !== null && pick.from <= n && n <= pick.to;
    const row = el('div', `src-line${inPick ? ' on' : ''}${pick?.from === n ? ' first' : ''}`);
    row.dataset.line = String(n);
    const band = bands[i] ?? -1;
    const mark = el(
      'span',
      `src-band${band < 0 ? '' : ` b${band % 2}`}${band >= 0 && band === pick?.chunk ? ' lit' : ''}`,
    );
    const code = el('code', 'src-code');
    code.innerHTML = lines[i] || ' ';
    row.append(el('span', 'src-ln', String(n)), mark, code);
    return row;
  });
  body.addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.src-line');
    if (row?.dataset.line) onLine(Number(row.dataset.line));
  });

  function drawMeta() {
    const c = pick ? chunks[pick.chunk] : undefined;
    const where = pick ? `L${lineSpan(pick.from, pick.to)}` : `${lines.length.toLocaleString('en-US')} lines`;
    meta.textContent = [where, c ? `chunk #${c.idx}${c.embedded ? ' · has its vector' : ''}` : '', lang ?? '']
      .filter(Boolean)
      .join(' · ');
  }

  function drawMode() {
    sourceTab.classList.toggle('on', mode === 'source');
    chunkTab.classList.toggle('on', mode === 'chunk');
    const c = pick ? chunks[pick.chunk] : undefined;
    chunkTab.disabled = !c;
    body.hidden = mode !== 'source';
    chunkBox.hidden = mode !== 'chunk' || !c;
    if (mode === 'chunk' && c) {
      chunkBox.innerHTML = highlightFile(c.text, ext).html;
      chunkBox.scrollTop = 0;
    }
  }

  sourceTab.addEventListener('click', () => {
    mode = 'source';
    drawMode();
    list.redraw();
  });
  chunkTab.addEventListener('click', () => {
    mode = 'chunk';
    drawMode();
  });

  return {
    root,
    /** A file's text and its chunks (nothing picked yet). */
    show(text: string, fileExt: string, fileChunks: ContextChunk[]) {
      ext = fileExt;
      chunks = fileChunks;
      ({ lines, lang } = highlightLines(text, ext));
      if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
      bands = chunkBands(chunks, lines.length);
      pick = null;
      note.hidden = true;
      body.scrollTop = 0;
      list.setCount(lines.length);
      drawMeta();
      drawMode();
    },
    /** No text to show (still reading it, or it couldn't be read): `why`. */
    say(why: string) {
      lines = [];
      bands = [];
      list.setCount(0);
      note.textContent = why;
      note.hidden = false;
      drawMeta();
    },
    /** Mark what's picked, and scroll to it (a third of the way down, if it's out of view). */
    pick(p: SourcePick) {
      pick = p;
      drawMeta();
      drawMode();
      list.redraw();
      if (!p || mode !== 'source') return;
      const top = (p.from - 1) * LINE;
      const bottom = p.to * LINE;
      if (top < body.scrollTop || bottom > body.scrollTop + body.clientHeight)
        body.scrollTop = Math.max(0, top - body.clientHeight / 3);
    },
  };
}
export type Source = ReturnType<typeof createSource>;
