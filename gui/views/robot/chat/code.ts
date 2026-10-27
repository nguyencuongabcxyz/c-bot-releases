// Code blocks in the chat, as an editor shows them: highlighted (highlight.js, the common
// languages), under a header with the language and a Copy button (robot.ts copies on click).
import hljs from 'highlight.js/lib/common';

/** Highlight each `<pre><code class="language-x">` in `root` and give it its header. Only a
 *  language the block names is highlighted (no guessing: the words stream in as it writes). */
export function dressCode(root: ParentNode) {
  for (const code of root.querySelectorAll<HTMLElement>('pre > code')) {
    const pre = code.parentElement!;
    if (pre.parentElement?.classList.contains('codeblock')) continue;
    const lang = /(?:^|\s)language-([\w+#.-]+)/.exec(code.className)?.[1]?.toLowerCase() ?? '';
    const known = lang ? hljs.getLanguage(lang) : undefined;
    if (known) {
      code.innerHTML = hljs.highlight(code.textContent ?? '', { language: lang, ignoreIllegals: true }).value;
      code.classList.add('hljs');
    }
    const box = document.createElement('div');
    box.className = 'codeblock';
    const head = document.createElement('div');
    head.className = 'code-head';
    const name = document.createElement('span');
    name.className = 'code-lang';
    name.textContent = known?.name ?? (lang || 'text');
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'code-copy';
    copy.title = 'Copy the code';
    copy.textContent = 'Copy';
    head.append(name, copy);
    pre.replaceWith(box);
    box.append(head, pre);
  }
}
