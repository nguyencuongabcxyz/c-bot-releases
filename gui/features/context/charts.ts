// Small charts for the context engine's details (details.ts), drawn with SVG and CSS: a ring
// for a share done, a progress bar, a stacked bar with its legend for a whole cut into parts, a
// tile for a number, a pill for a state. Their colours are the theme's tones (context.css
// .t0–.t5: the accent, violet, ok, warn, danger, muted), so they follow the theme and the mode.
import { Icon } from '@/icons/icons';
import { el } from '@/lib/dom';

/** One of the theme's tones, by its place: accent, violet, ok, warn, danger, muted. */
export type Tone = 0 | 1 | 2 | 3 | 4 | 5;
/** A part of a whole: its name, its value, its share (0–100) and its tone. */
export type Share = { name: string; value: number; pct: number; tone: Tone };

const MUTED: Tone = 5;
const RING_R = 18;
const RING_LEN = 2 * Math.PI * RING_R;

/** The parts of a whole, biggest first: the first `max - 1` as they are and the rest as one
 * "Other" (muted), each with its share; nothing of no value. */
export function shares(items: { name: string; value: number }[], max = 5): Share[] {
  const kept = items.filter((i) => i.value > 0).sort((a, b) => b.value - a.value);
  const total = kept.reduce((n, i) => n + i.value, 0);
  if (!total) return [];
  const head = kept.length > max ? kept.slice(0, max - 1) : kept;
  const rest = kept.slice(head.length).reduce((n, i) => n + i.value, 0);
  const out: Share[] = head.map((i, k) => ({ ...i, pct: (i.value / total) * 100, tone: (k % 5) as Tone }));
  if (rest) out.push({ name: 'Other', value: rest, pct: (rest / total) * 100, tone: MUTED });
  return out;
}

/** A ring showing `pct` done, its value in the middle, its label and a line under it. */
export function ring(label: string, tone: Tone): HTMLElement {
  const box = el('div', `cx-ring t${tone}`);
  box.innerHTML =
    `<svg viewBox="0 0 44 44" aria-hidden="true"><circle class="track" cx="22" cy="22" r="${RING_R}"/>` +
    `<circle class="arc" cx="22" cy="22" r="${RING_R}" stroke-dasharray="${RING_LEN.toFixed(1)}" stroke-dashoffset="${RING_LEN.toFixed(1)}"/></svg>`;
  box.append(el('div', 'cx-ring-val'), el('div', 'cx-ring-label', label), el('div', 'cx-ring-sub'));
  return box;
}

/** Set a ring to `pct` (0–100; null: nothing to show yet), with its line under it. */
export function setRing(box: HTMLElement, pct: number | null, sub: string, busy = false) {
  const p = pct === null ? 0 : Math.max(0, Math.min(100, pct));
  box.querySelector('.arc')?.setAttribute('stroke-dashoffset', ((1 - p / 100) * RING_LEN).toFixed(1));
  const val = box.querySelector('.cx-ring-val');
  if (val) val.textContent = pct === null ? '–' : `${Math.floor(p)}%`;
  const line = box.querySelector('.cx-ring-sub');
  if (line) line.textContent = sub;
  box.classList.toggle('busy', busy);
}

/** A progress bar, `pct` full. */
export function bar(pct: number, tone: Tone): HTMLElement {
  const track = el('div', `cx-bar t${tone}`);
  const fill = el('i');
  fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  track.append(fill);
  return track;
}

/** A whole cut into its parts, side by side. */
export function stack(parts: Share[]): HTMLElement {
  const track = el('div', 'cx-stack');
  for (const s of parts) {
    const seg = el('i', `t${s.tone}`);
    seg.style.width = `${s.pct}%`;
    seg.title = s.name;
    track.append(seg);
  }
  return track;
}

/** The parts' names and what each is (`say`), a dot of its colour before each. */
export function legend(parts: Share[], say: (s: Share) => string): HTMLElement {
  const list = el('ul', 'cx-legend');
  for (const s of parts) {
    const li = el('li', `t${s.tone}`);
    li.append(el('b', '', s.name), el('span', '', say(s)));
    list.append(li);
  }
  return list;
}

/** A number with its icon and what it counts. */
export function tile(icon: string, label: string): HTMLElement {
  const box = el('div', 'cx-tile');
  const head = el('div', 'cx-tile-label');
  head.innerHTML = Icon(icon, 'sm');
  head.append(label);
  box.append(el('div', 'cx-tile-val', '–'), head);
  return box;
}

/** Set a tile's number. */
export function setTile(box: HTMLElement, value: string) {
  const v = box.querySelector('.cx-tile-val');
  if (v) v.textContent = value;
}

/** A state, as a small coloured label (pulsing while it's under way). */
export function pill(text: string, tone: Tone, busy = false): HTMLElement {
  return el('span', `cx-pill t${tone}${busy ? ' busy' : ''}`, text);
}
