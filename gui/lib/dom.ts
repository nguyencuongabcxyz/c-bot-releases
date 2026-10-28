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
