import { describe, expect, it } from 'vitest';
import { highlightLines, splitLines } from './code';

describe('highlighted code, line by line', () => {
  it('cuts at the line breaks', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b', '']);
    expect(splitLines('')).toEqual(['']);
  });

  it('closes a span still open at a break and opens it again on the next line', () => {
    const html = 'x <span class="hljs-comment">/* one\ntwo */</span> y';
    expect(splitLines(html)).toEqual([
      'x <span class="hljs-comment">/* one</span>',
      '<span class="hljs-comment">two */</span> y',
    ]);
  });

  it('keeps spans inside spans whole on each line', () => {
    const html = '<span class="a">1<span class="b">2\n3</span>4\n5</span>';
    expect(splitLines(html)).toEqual([
      '<span class="a">1<span class="b">2</span></span>',
      '<span class="a"><span class="b">3</span>4</span>',
      '<span class="a">5</span>',
    ]);
  });

  it('highlights a file and gives one line of HTML per line of text', () => {
    const { lines, lang } = highlightLines('const a = 1;\n/* x\ny */\n', 'ts');
    expect(lang).toBe('TypeScript');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('hljs-keyword');
    expect(lines[2]).toMatch(/^<span class="hljs-comment">y \*\/<\/span>$/);
  });

  it('leaves text of no known language as it is, escaped', () => {
    expect(highlightLines('<a>\nb', 'zzz')).toEqual({ lines: ['&lt;a&gt;', 'b'], lang: null });
  });
});
