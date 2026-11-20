// Finding and making elements, the same way in every page.
import { Icon } from '@/icons/icons';

/** The element `sel` finds (in `root`). A view's markup always has it, so a miss is a bug: it throws. */
export function $<E extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): E {
  const found = root.querySelector<E>(sel);
  if (!found) throw new Error(`Nothing matches ${sel}`);
  return found;
}

/** A new element, with its class and its text (either may be left out). */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/** A small button showing an icon (icons/icons.ts), and its label after it if it has one. */
export function iconButton(cls: string, title: string, icon: string, label = ''): HTMLButtonElement {
  const b = el('button', cls);
  b.type = 'button';
  b.title = title;
  b.innerHTML = Icon(icon, 'sm');
  if (label) b.append(label);
  return b;
}

/** Set a CSS variable on the page's root, only when it changes: each write makes the browser
 *  restyle the whole page (a long chat and all, ~10 ms), so only for what changes rarely (the
 *  robot's colour and size); what the layout or the mouse moves goes through `setVar`. */
export function setRootVar(name: string, value: string) {
  setVar(document.documentElement, name, value);
}

/** Set a CSS variable on the elements that use it, only where it changes. Set on an element
 *  holding the chat, it restyles the whole chat like the root does, unless the variable is
 *  registered with `inherits: false` (`@property`, views/robot/robot.css): then only the
 *  element itself is restyled. */
export function setVar(els: HTMLElement | HTMLElement[], name: string, value: string) {
  for (const e of Array.isArray(els) ? els : [els])
    if (e.style.getPropertyValue(name) !== value) e.style.setProperty(name, value);
}
