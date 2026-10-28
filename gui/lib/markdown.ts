// Markdown to safe HTML: marked to parse it, DOMPurify to keep only what's harmless. Each
// renderer has its own parser and sanitizer, so one page's extensions and hooks never reach
// another's.
import createDOMPurify, { type Config } from 'dompurify';
import { Marked, type MarkedExtension } from 'marked';

export type MarkdownOptions = {
  /** A single line break is a <br> (chat style). Default true. */
  breaks?: boolean;
  /** Links get target=_blank (the page opens them outside). Default true. */
  newTab?: boolean;
  /** marked extensions (walkTokens and the like). */
  extensions?: MarkedExtension[];
  /** DOMPurify settings on top of its defaults. */
  purify?: Config;
};

export type Markdown = {
  /** The text as sanitized HTML. */
  html: (text: string) => string;
  /** The text as a sanitized fragment, to change before it's shown. */
  fragment: (text: string) => DocumentFragment;
};

export function markdown({
  breaks = true,
  newTab = true,
  extensions = [],
  purify = {},
}: MarkdownOptions = {}): Markdown {
  const parser = new Marked({ gfm: true, breaks }, ...extensions);
  const sanitizer = createDOMPurify(window);
  if (newTab)
    sanitizer.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName !== 'A') return;
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    });
  // (no async extensions: parsed straight away)
  const parse = (text: string) => parser.parse(text || '', { async: false });
  return {
    html: (text) => sanitizer.sanitize(parse(text), { ...purify, RETURN_DOM_FRAGMENT: false, RETURN_DOM: false }),
    fragment: (text) => sanitizer.sanitize(parse(text), { ...purify, RETURN_DOM_FRAGMENT: true }),
  };
}
