import { describe, expect, it } from 'vitest';
import type { ContextRepo } from '@/types/model';
import { forgetQuestion, names, wipeQuestion, wipedText } from './wipe';

const repo = (robots: string[]): ContextRepo => ({
  root: 'C:\\work\\shop\\',
  files: 1,
  chunks: 1,
  embedded: 1,
  generation: 1,
  robots,
  current: false,
  open: true,
  kinds: [],
  bytes: 1,
});

describe('deleting what the context engine keeps, in words', () => {
  it('puts names in a sentence', () => {
    expect(names([])).toBe('');
    expect(names(['Bolt'])).toBe('Bolt');
    expect(names(['Bolt', 'Pip'])).toBe('Bolt and Pip');
    expect(names(['Bolt', 'Pip', 'Ada'])).toBe('Bolt, Pip and Ada');
  });

  it('asks about one folder, naming the robots it switches off', () => {
    expect(forgetQuestion(repo([]))).toBe(
      'Delete the index of shop? Its files stay as they are: switching the engine on again reads them afresh.',
    );
    expect(forgetQuestion(repo(['Bolt', 'Pip']))).toContain(
      'shop? The context engine will be switched off for Bolt and Pip. Its files',
    );
  });

  it('says the downloads stay, or that they come down again', () => {
    expect(wipeQuestion('indexes', 5)).toContain('The downloads stay');
    expect(wipeQuestion('everything', 3 * 1024 * 1024)).toMatch(/downloads them again \(3\.0 MB\)\.$/);
    expect(wipeQuestion('everything', 0)).toMatch(/downloads them again\.$/);
  });

  it('says what went, how much, who it switched off, and what waits for a restart', () => {
    expect(wipedText('Deleted every index', { freed: 2048, later: false, robots: [] })).toBe(
      'Deleted every index: 2.0 KB freed.',
    );
    expect(wipedText('Deleted the index of shop', { freed: 2048, later: true, robots: ['Bolt'] }, false)).toBe(
      'Deleted the index of shop. The context engine is off for Bolt. Some of it was in use: it goes the next time C-Bot starts.',
    );
    expect(wipedText('Deleted everything', { freed: 0, later: false, robots: [] })).toBe('Deleted everything.');
  });
});
