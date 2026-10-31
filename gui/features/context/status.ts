// How the context engine's index of a folder is, in words: what its button in the chat's brain
// bar says (and the bar under it while it works), the line on top of its menu, and how each of
// its indexes is (the dots beside the button, the chat's panel and the window).
import type { ContextEngineStatus } from '@/types/model';

const count = (n: number) => n.toLocaleString('en-US');

/** What the index is doing while it works: setting up, reading the folder, or giving its chunks
 * their vectors (search by meaning; also while the model downloads). */
export type ContextStage = 'setup' | 'reading' | 'meaning';
/** How far it's got (pct null: no telling yet). */
export type ContextProgress = { stage: ContextStage; pct: number | null };

/** What it's doing and how far it's got; null when it isn't working (off, ready, failed). */
export function contextProgress(s: ContextEngineStatus): ContextProgress | null {
  switch (s.phase) {
    case 'installing':
      return { stage: 'setup', pct: null };
    case 'indexing':
      return { stage: 'reading', pct: s.total ? (s.done / s.total) * 100 : null };
    case 'ready':
      if (!s.note && (!s.chunks || s.embedded >= s.chunks)) return null;
      return { stage: 'meaning', pct: !s.note && s.chunks ? (s.embedded / s.chunks) * 100 : null };
    default:
      return null;
  }
}

/** How far search by meaning has got, while it's getting there (or what it's doing: the model's download). */
function meaning(s: ContextEngineStatus): string {
  if (s.note) return ` · ${s.note}`;
  if (!s.chunks || s.embedded >= s.chunks) return '';
  return ` · search by meaning ${Math.floor((s.embedded / s.chunks) * 100)}%`;
}

/** What the button says: off, setting up, how far a reading has got, or how many files it knows
 * (and how far search by meaning has got, while it's getting there). */
export function contextLabel(s: ContextEngineStatus): string {
  switch (s.phase) {
    case 'off':
      return 'off';
    case 'installing':
      return 'setting up…';
    case 'indexing':
      return s.total ? `${Math.floor((s.done / s.total) * 100)}%` : 'reading…';
    case 'ready': {
      const p = contextProgress(s);
      const more = !p ? '' : p.pct === null ? ' · …' : ` · ${Math.floor(p.pct)}%`;
      return `${count(s.files)} files${more}`;
    }
    case 'failed':
      return 'failed';
  }
}

/** The indexes a folder's made into: its syntax trees (the definitions the code tools read),
 * the keyword index, the vectors (search by meaning) and the code graph (who calls what). */
export type IndexKind = 'syntax' | 'keyword' | 'vectors' | 'graph';
/** How one is: off (the engine is), waiting its turn, being made, ready, or failed. */
export type IndexState = 'off' | 'wait' | 'work' | 'ready' | 'failed';
/** One index: what it is, how it is, a line about it, and how far it's got while it's made. */
export type IndexView = { kind: IndexKind; name: string; state: IndexState; detail: string; pct: number | null };

const INDEX_NAMES: Record<IndexKind, string> = {
  syntax: 'Syntax trees',
  keyword: 'Keyword index',
  vectors: 'Search by meaning',
  graph: 'Code graph',
};

function indexOf(kind: IndexKind, state: IndexState, detail: string, pct: number | null = null): IndexView {
  return { kind, name: INDEX_NAMES[kind], state, detail, pct };
}

/** How each index is, in its order. */
export function indexStates(s: ContextEngineStatus): IndexView[] {
  const all = (state: IndexState, detail: string) =>
    (['syntax', 'keyword', 'vectors', 'graph'] as const).map((k) => indexOf(k, state, detail));
  switch (s.phase) {
    case 'off':
      return all('off', 'off');
    case 'failed':
      return all('failed', s.error ?? 'failed');
    case 'installing':
      return [indexOf('syntax', 'work', s.note ?? 'setting up…'), ...all('wait', 'waits its turn').slice(1)];
    case 'indexing': {
      const pct = s.total ? (s.done / s.total) * 100 : null;
      const read = s.total ? `${count(s.done)} of ${count(s.total)} files` : 'looking for files…';
      return [
        indexOf('syntax', 'work', read, pct),
        indexOf('keyword', 'work', s.note ?? 'as files are read', pct),
        indexOf('vectors', 'wait', 'after the reading'),
        indexOf('graph', 'wait', 'after the reading'),
      ];
    }
    case 'ready': {
      const meaning = contextProgress(s);
      return [
        indexOf('syntax', 'ready', `${count(s.files)} files, ${count(s.symbols)} definitions`),
        indexOf('keyword', 'ready', `${count(s.chunks)} chunks`),
        meaning
          ? indexOf('vectors', 'work', s.note ?? `${count(s.embedded)} of ${count(s.chunks)} chunks`, meaning.pct)
          : indexOf('vectors', 'ready', `${count(s.embedded)} chunks`),
        s.graph
          ? indexOf('graph', 'ready', `${count(s.calls)} calls`)
          : indexOf('graph', 'work', 'built when first asked'),
      ];
    }
  }
}

/** How the index is, in a line. */
export function contextSummary(s: ContextEngineStatus): string {
  switch (s.phase) {
    case 'off':
      return 'Context engine: off';
    case 'installing':
      return s.note ?? 'Setting up the index…';
    case 'indexing':
      return s.total ? `Reading the code: ${count(s.done)} of ${count(s.total)} files` : 'Looking for the code…';
    case 'ready': {
      const calls = s.calls ? `, ${count(s.calls)} calls` : '';
      const capped = s.capped ? ' (not all: the folder has more)' : '';
      return `Indexed ${count(s.files)} files, ${count(s.symbols)} definitions${calls}${capped}${meaning(s)}`;
    }
    case 'failed':
      return `Context engine: ${s.error ?? "couldn't read the folder"}`;
  }
}
