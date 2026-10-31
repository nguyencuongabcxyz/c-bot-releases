import { describe, expect, it } from 'vitest';
import type { ContextFile } from '@/types/model';
import {
  chunkBands,
  chunkOf,
  defAt,
  fileKinds,
  filesLine,
  lines,
  matching,
  pickFiles,
  splitPath,
  vectors,
} from './files';

const file = (path: string, over: Partial<ContextFile> = {}): ContextFile => ({
  path,
  kind: 'Rust',
  code: true,
  bytes: 100,
  chunks: 2,
  embedded: 1,
  defs: 3,
  ...over,
});

const files = [
  file('src/main.rs', { defs: 10, bytes: 50 }),
  file('src/store/mod.rs', { chunks: 9, embedded: 9 }),
  file('README.md', { kind: 'Markdown', code: false, defs: 0, bytes: 900 }),
];
const paths = (fs: ContextFile[]) => fs.map((f) => f.path);

describe('the files of the index', () => {
  it('splits a path into its folder and its name', () => {
    expect(splitPath('src/store/mod.rs')).toEqual({ dir: 'src/store', name: 'mod.rs' });
    expect(splitPath('README.md')).toEqual({ dir: '', name: 'README.md' });
  });

  it('keeps the files with every word in their path, of the kind asked', () => {
    const byPath = { by: 'path', desc: false } as const;
    expect(paths(pickFiles(files, 'SRC mod', '', byPath))).toEqual(['src/store/mod.rs']);
    expect(paths(pickFiles(files, '', 'Markdown', byPath))).toEqual(['README.md']);
    expect(pickFiles(files, '  ', '', byPath)).toHaveLength(3);
  });

  it('sorts them by any column, either way, then by path', () => {
    expect(paths(pickFiles(files, '', '', { by: 'path', desc: false }))).toEqual([
      'README.md',
      'src/main.rs',
      'src/store/mod.rs',
    ]);
    expect(paths(pickFiles(files, '', '', { by: 'defs', desc: true }))).toEqual([
      'src/main.rs',
      'src/store/mod.rs',
      'README.md',
    ]);
    expect(paths(pickFiles([file('b.rs'), file('a.rs')], '', '', { by: 'defs', desc: true }))).toEqual([
      'a.rs',
      'b.rs',
    ]);
    expect(pickFiles(files, '', '', { by: 'bytes', desc: false })[0].path).toBe('src/main.rs');
    expect(pickFiles(files, '', '', { by: 'kind', desc: false })[0].path).toBe('README.md');
    expect(pickFiles(files, '', '', { by: 'vectors', desc: true })[0].path).toBe('src/store/mod.rs');
  });

  it('counts a file of no chunks as having all its vectors', () => {
    expect(vectors(file('a', { chunks: 4, embedded: 1 }))).toBe(0.25);
    expect(vectors(file('a', { chunks: 0, embedded: 0 }))).toBe(1);
  });

  it('counts the kinds, most first', () => {
    expect(fileKinds(files)).toEqual([
      { name: 'Rust', files: 2 },
      { name: 'Markdown', files: 1 },
    ]);
  });

  it('sums them up in a line', () => {
    expect(filesLine(files)).toBe('3 files · 13 definitions · 13 chunks (84% by meaning) · 1.0 KB');
    expect(filesLine([])).toBe('0 files · 0 definitions · 0 chunks (– by meaning) · 0 B');
  });

  it('finds the chunk a definition is in: the smallest that holds its first line', () => {
    const chunk = (idx: number, from: number, to: number) => ({
      idx,
      code: true,
      from,
      to,
      symbol: '',
      text: '',
      embedded: false,
    });
    const chunks = [chunk(0, 1, 40), chunk(1, 10, 20), chunk(2, 41, 60)];
    expect(chunkOf(chunks, 12)?.idx).toBe(1);
    expect(chunkOf(chunks, 5)?.idx).toBe(0);
    expect(chunkOf(chunks, 41)?.idx).toBe(2);
    expect(chunkOf(chunks, 99)).toBeUndefined();
  });

  it('knows the chunk each line is in, the innermost where they hold others', () => {
    const chunk = (from: number, to: number) => ({
      idx: 0,
      code: true,
      from,
      to,
      symbol: '',
      text: '',
      embedded: true,
    });
    expect(chunkBands([chunk(1, 6), chunk(3, 4), chunk(8, 9)], 10)).toEqual([0, 0, 1, 1, 0, 0, -1, 2, 2, -1]);
    expect(chunkBands([chunk(2, 99)], 3)).toEqual([-1, 0, 0]);
  });

  it('knows the definition a line is in, the innermost', () => {
    const def = (name: string, line: number, end: number) => ({
      name,
      kind: 'function' as const,
      container: null,
      line,
      end,
      depth: 0,
      sig: '',
    });
    const defs = [def('Store', 1, 30), def('open', 5, 9), def('close', 12, 14)];
    expect(defAt(defs, 6)).toBe(1);
    expect(defAt(defs, 20)).toBe(0);
    expect(defAt(defs, 40)).toBe(-1);
  });

  it('finds the items with every word asked, any case', () => {
    const names = ['openStore', 'closeStore', 'render'];
    expect(matching(names, 'STORE', (n) => n)).toEqual([0, 1]);
    expect(matching(names, 'store close', (n) => n)).toEqual([1]);
    expect(matching(names, ' ', (n) => n)).toEqual([0, 1, 2]);
  });

  it('says a definition’s lines', () => {
    expect(lines(12, 40)).toBe('12–40');
    expect(lines(7, 7)).toBe('7');
  });
});
