import { describe, expect, it } from 'vitest';
import { contextLabel, contextProgress, contextSummary, indexStates } from './status';
import type { ContextEngineStatus } from '@/types/model';

const status = (s: Partial<ContextEngineStatus>): ContextEngineStatus => ({
  phase: 'off',
  files: 0,
  chunks: 0,
  embedded: 0,
  symbols: 0,
  calls: 0,
  graph: false,
  done: 0,
  total: 0,
  capped: false,
  note: null,
  error: null,
  ...s,
});

describe('the context engine button', () => {
  it('says off, how far a reading has got, or how many files it knows', () => {
    expect(contextLabel(status({}))).toBe('off');
    expect(contextLabel(status({ phase: 'installing' }))).toBe('setting up…');
    expect(contextLabel(status({ phase: 'indexing' }))).toBe('reading…');
    expect(contextLabel(status({ phase: 'indexing', done: 1, total: 3 }))).toBe('33%');
    expect(contextLabel(status({ phase: 'ready', files: 1234 }))).toBe('1,234 files');
    expect(contextLabel(status({ phase: 'failed' }))).toBe('failed');
  });

  it('says how far search by meaning has got, while it is getting there', () => {
    expect(contextLabel(status({ phase: 'ready', files: 12, chunks: 200, embedded: 50 }))).toBe('12 files · 25%');
    expect(contextLabel(status({ phase: 'ready', files: 12, chunks: 9, note: 'Downloading…' }))).toBe('12 files · …');
    expect(contextLabel(status({ phase: 'ready', files: 12, chunks: 9, embedded: 9 }))).toBe('12 files');
  });

  it('shows the bar under it only while it works', () => {
    expect(contextProgress(status({}))).toBeNull();
    expect(contextProgress(status({ phase: 'installing' }))).toEqual({ stage: 'setup', pct: null });
    expect(contextProgress(status({ phase: 'indexing' }))).toEqual({ stage: 'reading', pct: null });
    expect(contextProgress(status({ phase: 'indexing', done: 1, total: 4 }))).toEqual({ stage: 'reading', pct: 25 });
    expect(contextProgress(status({ phase: 'ready', chunks: 10, embedded: 4 }))).toEqual({ stage: 'meaning', pct: 40 });
    expect(contextProgress(status({ phase: 'ready', chunks: 10, embedded: 4, note: 'Downloading…' }))).toEqual({
      stage: 'meaning',
      pct: null,
    });
    expect(contextProgress(status({ phase: 'ready', chunks: 10, embedded: 10 }))).toBeNull();
    expect(contextProgress(status({ phase: 'failed' }))).toBeNull();
  });

  it('says how each index is', () => {
    const states = (over: Partial<ContextEngineStatus>) => indexStates(status(over)).map((i) => [i.kind, i.state]);
    expect(states({})).toEqual([
      ['syntax', 'off'],
      ['keyword', 'off'],
      ['vectors', 'off'],
      ['graph', 'off'],
    ]);
    expect(states({ phase: 'indexing', done: 1, total: 4 })).toEqual([
      ['syntax', 'work'],
      ['keyword', 'work'],
      ['vectors', 'wait'],
      ['graph', 'wait'],
    ]);
    expect(states({ phase: 'ready', files: 3, chunks: 10, embedded: 4 })).toEqual([
      ['syntax', 'ready'],
      ['keyword', 'ready'],
      ['vectors', 'work'],
      ['graph', 'work'],
    ]);
    expect(states({ phase: 'ready', chunks: 10, embedded: 10, graph: true })).toEqual([
      ['syntax', 'ready'],
      ['keyword', 'ready'],
      ['vectors', 'ready'],
      ['graph', 'ready'],
    ]);
    expect(states({ phase: 'failed' }).every(([, s]) => s === 'failed')).toBe(true);
    expect(states({ phase: 'installing' })[0]).toEqual(['syntax', 'work']);
  });

  it('says a line about each index, and how far one being made has got', () => {
    const [syntax, , vectors, graph] = indexStates(
      status({ phase: 'ready', files: 1200, symbols: 40, chunks: 10, embedded: 4, graph: true, calls: 77 }),
    );
    expect(syntax.detail).toBe('1,200 files, 40 definitions');
    expect([vectors.detail, vectors.pct]).toEqual(['4 of 10 chunks', 40]);
    expect(graph.detail).toBe('77 calls');
    expect(indexStates(status({ phase: 'indexing', done: 1, total: 4 }))[0]).toMatchObject({
      detail: '1 of 4 files',
      pct: 25,
    });
  });

  it('sums the index up for its menu', () => {
    expect(contextSummary(status({ phase: 'installing', note: 'Downloading PostgreSQL (once)…' }))).toBe(
      'Downloading PostgreSQL (once)…',
    );
    expect(contextSummary(status({ phase: 'installing' }))).toBe('Setting up the index…');
    expect(contextSummary(status({ phase: 'indexing', done: 40, total: 1200 }))).toBe(
      'Reading the code: 40 of 1,200 files',
    );
    expect(contextSummary(status({ phase: 'ready', files: 12, symbols: 340, capped: true }))).toBe(
      'Indexed 12 files, 340 definitions (not all: the folder has more)',
    );
    expect(contextSummary(status({ phase: 'ready', files: 12, symbols: 340, calls: 1500 }))).toBe(
      'Indexed 12 files, 340 definitions, 1,500 calls',
    );
    expect(contextSummary(status({ phase: 'ready', files: 12, symbols: 340, chunks: 200, embedded: 50 }))).toBe(
      'Indexed 12 files, 340 definitions · search by meaning 25%',
    );
    expect(contextSummary(status({ phase: 'ready', files: 12, symbols: 3, chunks: 9, note: 'Downloading…' }))).toBe(
      'Indexed 12 files, 3 definitions · Downloading…',
    );
    expect(contextSummary(status({ phase: 'failed', error: 'The folder C:\\x isn’t there.' }))).toBe(
      'Context engine: The folder C:\\x isn’t there.',
    );
  });
});
