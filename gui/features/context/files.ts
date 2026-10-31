// The files of a folder's index, in words and in order (the Context engine window's Files):
// which to show for the words typed and the kind picked, sorted by any column, what they add up
// to; and in one file, the chunk a definition is in, the chunk each line is in, the definition
// a line is in, and the definitions or chunks that match some words. Pure (tested).
import type { ContextChunk, ContextDef, ContextFile } from '@/types/model';
import { percent, size } from './details';

/** A column the files can be sorted by. */
export type FilesSort = 'path' | 'kind' | 'defs' | 'chunks' | 'vectors' | 'bytes';
/** How the files are sorted: by a column, one way or the other. */
export type FilesOrder = { by: FilesSort; desc: boolean };

const count = (n: number) => n.toLocaleString('en-US');

/** A path's folder and its name. */
export function splitPath(path: string): { dir: string; name: string } {
  const at = path.lastIndexOf('/');
  return at < 0 ? { dir: '', name: path } : { dir: path.slice(0, at), name: path.slice(at + 1) };
}

/** A file's share of chunks with their vector (0–1; a file of no chunks has none to wait for). */
export const vectors = (f: ContextFile) => (f.chunks ? f.embedded / f.chunks : 1);

const KEYS: Record<FilesSort, (f: ContextFile) => string | number> = {
  path: (f) => f.path,
  kind: (f) => f.kind,
  defs: (f) => f.defs,
  chunks: (f) => f.chunks,
  vectors,
  bytes: (f) => f.bytes,
};

/** The files whose path has every word of `query` (any case), of `kind` ('' for any), in order
 * (ties by path). */
export function pickFiles(files: ContextFile[], query: string, kind: string, order: FilesOrder): ContextFile[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const kept = files.filter((f) => {
    if (kind && f.kind !== kind) return false;
    const p = f.path.toLowerCase();
    return words.every((w) => p.includes(w));
  });
  const key = KEYS[order.by];
  const sign = order.desc ? -1 : 1;
  return kept.sort((a, b) => {
    const x = key(a);
    const y = key(b);
    const by = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
    return by * sign || a.path.localeCompare(b.path);
  });
}

/** The kinds of file there are, most first. */
export function fileKinds(files: ContextFile[]): { name: string; files: number }[] {
  const by = new Map<string, number>();
  for (const f of files) by.set(f.kind, (by.get(f.kind) ?? 0) + 1);
  return [...by]
    .map(([name, n]) => ({ name, files: n }))
    .sort((a, b) => b.files - a.files || a.name.localeCompare(b.name));
}

/** The files' numbers, in a line. */
export function filesLine(files: ContextFile[]): string {
  const sum = (k: 'chunks' | 'embedded' | 'defs' | 'bytes') => files.reduce((n, f) => n + f[k], 0);
  const chunks = sum('chunks');
  return [
    `${count(files.length)} files`,
    `${count(sum('defs'))} definitions`,
    `${count(chunks)} chunks (${percent(sum('embedded'), chunks)} by meaning)`,
    size(sum('bytes')),
  ].join(' · ');
}

/** The chunk a definition is in (the smallest that holds its first line). */
export function chunkOf(chunks: ContextChunk[], line: number): ContextChunk | undefined {
  return chunks.filter((c) => c.from <= line && line <= c.to).sort((a, b) => a.to - a.from - (b.to - b.from))[0];
}

/** For each of a file's `count` lines, the chunk it's in (its place in `chunks`; -1: none): the
 * smallest one, where chunks hold others. */
export function chunkBands(chunks: ContextChunk[], count: number): number[] {
  const bands = new Array<number>(count).fill(-1);
  const biggestFirst = chunks.map((c, i) => ({ c, i })).sort((a, b) => b.c.to - b.c.from - (a.c.to - a.c.from));
  for (const { c, i } of biggestFirst)
    for (let l = Math.max(1, c.from); l <= Math.min(count, c.to); l++) bands[l - 1] = i;
  return bands;
}

/** The definition a line is in (its place in `defs`; -1: none): the innermost one. */
export function defAt(defs: ContextDef[], line: number): number {
  let best = -1;
  defs.forEach((d, i) => {
    if (d.line > line || line > d.end) return;
    const b = defs[best];
    if (best < 0 || d.end - d.line < b.end - b.line) best = i;
  });
  return best;
}

/** The places in `items` whose words (`words` of each) have every word of `query`, any case. */
export function matching<T>(items: T[], query: string, words: (t: T) => string): number[] {
  const want = query.toLowerCase().split(/\s+/).filter(Boolean);
  const out: number[] = [];
  items.forEach((t, i) => {
    const w = words(t).toLowerCase();
    if (want.every((q) => w.includes(q))) out.push(i);
  });
  return out;
}

/** A definition's lines: "12" or "12–40". */
export const lines = (from: number, to: number) => (to > from ? `${from}–${to}` : `${from}`);
