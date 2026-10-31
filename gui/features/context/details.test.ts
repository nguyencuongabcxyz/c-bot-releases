import { describe, expect, it } from 'vitest';
import type { ContextEngineDetails, ContextEngineStatus, ContextFolderDetails } from '@/types/model';
import {
  ago,
  baseName,
  diskShares,
  indexRows,
  meaningProgress,
  percent,
  phasePill,
  readProgress,
  repoMeta,
  size,
} from './details';

const status = (over: Partial<ContextEngineStatus> = {}): ContextEngineStatus => ({
  phase: 'ready',
  files: 12,
  chunks: 40,
  embedded: 30,
  symbols: 90,
  calls: 55,
  graph: true,
  done: 0,
  total: 0,
  capped: false,
  note: null,
  error: null,
  ...over,
});

describe('sizes, times, shares and names in words', () => {
  it('says a size in the unit it fits', () => {
    expect(size(512)).toBe('512 B');
    expect(size(2048)).toBe('2.0 KB');
    expect(size(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(size(470_000_000)).toBe('448 MB');
  });
  it('says how long ago', () => {
    expect(ago(1000, 1000 + 10_000)).toBe('just now');
    expect(ago(0, 5 * 60_000)).toBe('5 min ago');
    expect(ago(0, 3 * 3_600_000)).toBe('3 h ago');
    expect(ago(0, 86_400_000)).toBe('1 day ago');
    expect(ago(0, 3 * 86_400_000)).toBe('3 days ago');
  });
  it('says a share of nothing as a dash', () => {
    expect(percent(30, 40)).toBe('75%');
    expect(percent(0, 0)).toBe('–');
  });
  it('names a folder by the last part of its path', () => {
    expect(baseName('C:\\work\\shop\\')).toBe('shop');
    expect(baseName('/home/me/app')).toBe('app');
  });
});

describe('the rings and the state', () => {
  it('shows how far a reading has got, then the files read', () => {
    expect(readProgress(status({ phase: 'indexing', done: 25, total: 100 }))).toEqual({
      pct: 25,
      sub: '25 / 100 files',
      busy: true,
    });
    expect(readProgress(status({ phase: 'indexing' })).pct).toBeNull();
    expect(readProgress(status({ capped: true }))).toEqual({ pct: 100, sub: '12 files (not all)', busy: false });
    expect(readProgress(status({ phase: 'failed', error: 'no folder' })).sub).toBe('no folder');
  });
  it('shows search by meaning moving while chunks still wait for their vectors', () => {
    expect(meaningProgress(status())).toEqual({ pct: 75, sub: '30 / 40 chunks', busy: true });
    expect(meaningProgress(status({ embedded: 40 })).busy).toBe(false);
    expect(meaningProgress(status({ note: 'Downloading the search model: 40%' })).sub).toBe(
      'Downloading the search model: 40%',
    );
    expect(meaningProgress(status({ chunks: 0, embedded: 0 })).pct).toBeNull();
  });
  it('says the state on a pill, pulsing while under way', () => {
    expect(phasePill(status())).toEqual({ text: 'Ready', tone: 2, busy: false });
    expect(phasePill(status({ phase: 'indexing' }))).toEqual({ text: 'Reading', tone: 0, busy: true });
    expect(phasePill(status({ phase: 'failed' })).tone).toBe(4);
  });
});

describe('the disk and the repositories', () => {
  const details: ContextEngineDetails = {
    folder: null,
    store: { version: '18.6.1', port: 1, dataDir: 'd', startedHere: true, bytes: 300, vectors: [] },
    repos: [],
    models: [
      { role: 'sentence', name: 's', downloaded: true, loaded: true, bytes: 600 },
      { role: 'reranker', name: 'r', downloaded: false, loaded: false, bytes: 0 },
      { role: 'runtime', name: 'o', downloaded: true, loaded: true, bytes: 100 },
    ],
    dir: 'x',
  };
  it('cuts the disk the engine takes into its parts, biggest first', () => {
    expect(diskShares(details).map((s) => [s.name, s.value])).toEqual([
      ['Search model', 600],
      ['Database', 300],
      ['ONNX Runtime', 100],
    ]);
  });
  it('says what a repository holds', () => {
    const repo = {
      root: 'C:\\a',
      files: 1200,
      chunks: 5000,
      embedded: 10,
      generation: 3,
      robots: [],
      current: false,
      open: false,
      kinds: [],
      bytes: 3 * 1024 * 1024,
    };
    expect(repoMeta(repo)).toBe('1,200 files · 5,000 chunks · 3.0 MB');
  });
});

describe('every field of the index', () => {
  const folder: ContextFolderDetails = {
    root: 'C:\\shop',
    status: status({ capped: true }),
    watched: false,
    readAt: null,
    languages: [
      { name: 'Rust', files: 8 },
      { name: 'YAML', files: 1 },
    ],
    docs: 3,
    keywordBytes: 2048,
    vectorsInMemory: 0,
    graphBuilt: false,
    git: null,
  };
  it('shows every field of the index', () => {
    const rows = new Map(indexRows(folder));
    expect(rows.get('Folder')).toBe('C:\\shop');
    expect(rows.get('Files')).toBe('12 (not all: the folder has more)');
    expect(rows.get('Code files')).toBe('9');
    expect(rows.get('Calls')).toBe('not built yet');
    expect(rows.get('By meaning')).toBe('30 of 40 (75%)');
    expect(rows.get('Keyword index')).toBe('2.0 KB');
    expect(rows.get('Read')).toBe('not yet');
    expect(rows.has('Error')).toBe(false);
  });
  it('says only what the store knows of a folder no robot reads now', () => {
    const rows = new Map(indexRows(folder, false));
    expect(rows.get('State')).toBe('Not loaded: no robot with the engine on reads it now');
    expect(rows.get('Definitions')).toBe('90');
    for (const gone of ['Calls', 'Watched', 'Read', 'Code graph', 'Vectors in memory'])
      expect(rows.has(gone)).toBe(false);
  });
  it('says what it is doing, and what went wrong', () => {
    const rows = new Map(
      indexRows({ ...folder, status: status({ phase: 'indexing', done: 3, total: 9, note: 'n', error: 'e' }) }),
    );
    expect([rows.get('Reading'), rows.get('Now'), rows.get('Error')]).toEqual(['3 of 9', 'n', 'e']);
  });
});
