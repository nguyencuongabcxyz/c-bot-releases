// @vitest-environment jsdom
// (DOMPurify parses with the page's own HTML parser, and happy-dom's mangles it: <p> lost,
// <script> kept. jsdom parses as a browser does.)
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { describe, expect, test } from 'vitest';
import { markdown } from './markdown';

const SAMPLES = [
  '# Title\n\nSome **bold** and `code`.',
  'line one\nline two',
  '[a link](https://example.com) and <script>alert(1)</script>',
  '- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |',
  '<img src=x onerror=alert(1)>',
  '',
];

// What the pages did before lib/markdown.ts: the global marked and DOMPurify, set up in the
// page (robot.ts, groupchat.ts). The shared renderer must give the same HTML.
marked.setOptions({ gfm: true, breaks: true });
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});
const before = (text: string) => DOMPurify.sanitize(marked.parse(text || '') as string);

describe('markdown', () => {
  const md = markdown();

  test.each(SAMPLES)('same HTML as before: %j', (text) => {
    expect(md.html(text)).toBe(before(text));
  });

  test('links open outside, scripts are gone', () => {
    const html = md.html('[x](https://example.com) <script>alert(1)</script>');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain('<script');
  });

  test('a fragment holds the same markup', () => {
    const box = document.createElement('div');
    box.append(md.fragment(SAMPLES[0]));
    expect(box.innerHTML).toBe(md.html(SAMPLES[0]));
  });

  test('a fragment with DOMPurify settings: same as before (the robot chat)', () => {
    const ALLOWED_URI_REGEXP = /^(?:(?:(?:f|ht)tps?|mailto|tel|cbot-file):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;
    const text = '![pic](cbot-file://img/a.png) [doc](cbot-file://open/b.txt) [bad](javascript:alert(1))';
    const serialize = (f: DocumentFragment) => {
      const box = document.createElement('div');
      box.append(f);
      return box.innerHTML;
    };
    // (a fragment empties as it's appended: each is serialized once)
    const old = serialize(
      DOMPurify.sanitize(marked.parse(text) as string, { ALLOWED_URI_REGEXP, RETURN_DOM_FRAGMENT: true }),
    );
    const now = serialize(markdown({ purify: { ALLOWED_URI_REGEXP } }).fragment(text));
    expect(now).toBe(old);
    expect(now).toContain('cbot-file://img/a.png');
    expect(now).not.toContain('javascript:');
  });

  test('without breaks or new tabs (Quick actions)', () => {
    const plain = markdown({ breaks: false, newTab: false });
    expect(plain.html('a\nb')).not.toContain('<br>');
    expect(plain.html('[x](https://example.com)')).not.toContain('target=');
  });

  test('extensions apply to their own renderer only', () => {
    const shouting = markdown({
      extensions: [
        {
          walkTokens(t) {
            if (t.type === 'text') t.text = t.text.toUpperCase();
          },
        },
      ],
    });
    expect(shouting.html('hi')).toBe('<p>HI</p>\n');
    expect(md.html('hi')).toBe('<p>hi</p>\n');
  });
});
