// The composer's formatting: markdown around what's selected (bold, code, a list…) and changes
// to the text itself (UPPER CASE, lines joined, JSON tidied…). Every change goes in as typing
// would (insertText), so Ctrl+Z takes it back.

type Box = HTMLTextAreaElement;

/** Put `text` in place of what's from `from` to `to`, then select `selFrom`..`selTo` of it. */
function put(box: Box, from: number, to: number, text: string, selFrom = text.length, selTo = selFrom) {
  box.focus();
  box.setSelectionRange(from, to);
  if (!document.execCommand('insertText', false, text)) box.setRangeText(text, from, to, 'end'); // (no undo, but done)
  box.setSelectionRange(from + selFrom, from + selTo);
  box.dispatchEvent(new Event('input', { bubbles: true }));
}

/** `**`…`**` round the selection (or round a placeholder to type over); again takes it off. */
export function wrap(box: Box, before: string, after = before, placeholder = 'text') {
  const { selectionStart: s, selectionEnd: e, value } = box;
  const sel = value.slice(s, e);
  if (sel.startsWith(before) && sel.endsWith(after) && sel.length >= before.length + after.length) {
    return put(box, s, e, sel.slice(before.length, sel.length - after.length), 0, sel.length - before.length - after.length);
  }
  if (value.slice(s - before.length, s) === before && value.slice(e, e + after.length) === after) {
    return put(box, s - before.length, e + after.length, sel, 0, sel.length);
  }
  const inner = sel || placeholder;
  put(box, s, e, `${before}${inner}${after}`, before.length, before.length + inner.length);
}

/** The whole lines the selection touches. */
function lines(box: Box) {
  const { selectionStart: s, selectionEnd: e, value } = box;
  const from = value.lastIndexOf('\n', s - 1) + 1;
  const end = value.indexOf('\n', e > s && value[e - 1] === '\n' ? e - 1 : e);
  const to = end < 0 ? value.length : end;
  return { from, to, text: value.slice(from, to) };
}

/** Each line starts with `prefix` ("> ", "- ", or "1. " numbered); again takes it off. */
export function prefixLines(box: Box, kind: 'quote' | 'bullet' | 'number') {
  const { from, to, text } = lines(box);
  const rows = text.split('\n');
  const pattern = { quote: /^> ?/, bullet: /^[-*] /, number: /^\d+[.)] / }[kind];
  const done = rows.every((r) => pattern.test(r) || !r.trim());
  const next = rows.map((r, i) => {
    if (done) return r.replace(pattern, '');
    if (!r.trim() && rows.length > 1) return r;
    return `${kind === 'quote' ? '> ' : kind === 'bullet' ? '- ' : `${i + 1}. `}${r.replace(/^(?:> ?|[-*] |\d+[.)] )/, '')}`;
  });
  const out = next.join('\n');
  put(box, from, to, out, 0, out.length);
}

/** A fenced code block round the selected lines (an empty one to type into). */
export function codeBlock(box: Box, lang = '') {
  const { selectionStart: s, selectionEnd: e, value } = box;
  if (s === e) {
    const before = s > 0 && value[s - 1] !== '\n' ? '\n' : '';
    return put(box, s, e, `${before}\`\`\`${lang}\n\n\`\`\`\n`, before.length + 4 + lang.length);
  }
  const { from, to, text } = lines(box);
  const fenced = /^```[^\n]*\n([\s\S]*)\n```$/.exec(text);
  if (fenced) return put(box, from, to, fenced[1], 0, fenced[1].length);
  const out = `\`\`\`${lang}\n${text}\n\`\`\``;
  put(box, from, to, out, 0, out.length);
}

/** [the selection](url), with the url selected to type over. */
export function link(box: Box) {
  const { selectionStart: s, selectionEnd: e, value } = box;
  const sel = value.slice(s, e);
  if (/^https?:\/\/\S+$/.test(sel)) return put(box, s, e, `[link](${sel})`, 1, 5);
  const label = sel || 'link';
  put(box, s, e, `[${label}](url)`, label.length + 3, label.length + 6);
}

/** Ways to change the text itself (the selection, or all of it). */
export const TRANSFORMS: { id: string; label: string; desc: string; run: (t: string) => string }[] = [
  { id: 'upper', label: 'UPPER CASE', desc: 'every letter a capital', run: (t) => t.toUpperCase() },
  { id: 'lower', label: 'lower case', desc: 'no capitals', run: (t) => t.toLowerCase() },
  { id: 'title', label: 'Title Case', desc: 'Each Word Starts With A Capital', run: (t) => t.toLowerCase().replace(/(^|[\s\-_/([{"'])(\p{L})/gu, (_, a, b) => a + b.toUpperCase()) },
  { id: 'sentence', label: 'Sentence case', desc: 'a capital after each full stop', run: (t) => t.toLowerCase().replace(/(^\s*|[.!?]\s+)(\p{L})/gu, (_, a, b) => a + b.toUpperCase()) },
  { id: 'join', label: 'Join lines', desc: 'one paragraph, line breaks gone', run: (t) => t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(' ') },
  { id: 'tidy', label: 'Tidy spaces', desc: 'no double spaces or trailing blanks, at most one empty line', run: (t) => t.replace(/[ \t]+/g, ' ').replace(/ +$/gm, '').replace(/\n{3,}/g, '\n\n').trim() },
  { id: 'bullets', label: 'Lines → list', desc: 'each line a bullet point', run: (t) => t.split(/\r?\n/).filter((l) => l.trim()).map((l) => `- ${l.trim().replace(/^[-*•]\s*/, '')}`).join('\n') },
  { id: 'sort', label: 'Sort lines', desc: 'A to Z', run: (t) => t.split(/\r?\n/).sort((a, b) => a.localeCompare(b)).join('\n') },
  {
    id: 'json',
    label: 'Tidy JSON',
    desc: 'indented, in a code block',
    run: (t) => {
      try {
        return `\`\`\`json\n${JSON.stringify(JSON.parse(t), null, 2)}\n\`\`\``;
      } catch {
        return t; // (not JSON: left as it is)
      }
    },
  },
  { id: 'plain', label: 'Strip markdown', desc: 'plain text: no **, `, #, > or links', run: (t) => t.replace(/```[^\n]*\n?/g, '').replace(/(\*\*|__|~~|`)/g, '').replace(/^(#+|>)\s?/gm, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') },
];

/** Change the selection (or, with nothing selected, all of it) with one of the TRANSFORMS. */
export function transform(box: Box, id: string) {
  const t = TRANSFORMS.find((x) => x.id === id);
  if (!t) return false;
  let { selectionStart: s, selectionEnd: e } = box;
  if (s === e) [s, e] = [0, box.value.length];
  const before = box.value.slice(s, e);
  const after = t.run(before);
  if (after === before) return false;
  put(box, s, e, after, 0, after.length);
  return true;
}
