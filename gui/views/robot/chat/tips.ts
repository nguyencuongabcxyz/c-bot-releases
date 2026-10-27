// Tooltips in the chat, drawn here: the webview's own (from title="…") hardly ever shows
// in this see-through window. Hovering anything with a title moves it to data-tip (so the
// native one can't pop up too) and, after a moment, shows it in a little label by the button.

const DELAY = 450; // ms of hovering before the first one shows
const WARM = 300; // ms after one hides that the next shows straight away
const GAP = 6;

/** Give everything with a title inside `root` our tooltip (titles added later count too). */
export function tooltips(root: HTMLElement) {
  const tip = document.createElement('div');
  tip.className = 'chat-tip';
  tip.setAttribute('role', 'tooltip');
  document.body.appendChild(tip);

  let target: HTMLElement | null = null;
  let timer = 0;
  let hiddenAt = 0;

  const tipped = (el: EventTarget | null) => {
    const hit = el instanceof Element ? el.closest<HTMLElement>('[title], [data-tip]') : null;
    return hit && root.contains(hit) ? hit : null;
  };

  function place(el: HTMLElement) {
    const r = el.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    // below the button if it fits, else above
    let top = r.bottom + GAP;
    if (top + t.height > vh - GAP) top = Math.max(GAP, r.top - GAP - t.height);
    const left = Math.min(Math.max(GAP, r.left + r.width / 2 - t.width / 2), vw - GAP - t.width);
    tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  function show(el: HTMLElement) {
    const text = el.dataset.tip;
    if (!text || !el.isConnected) return;
    tip.textContent = text;
    tip.classList.add('show');
    place(el);
  }

  function hide() {
    clearTimeout(timer);
    if (tip.classList.contains('show')) hiddenAt = performance.now();
    tip.classList.remove('show');
    target = null;
  }

  root.addEventListener('pointerover', (e) => {
    const el = tipped(e.target);
    if (el === target) return;
    hide();
    if (!el) return;
    // (a title set since the last hover, e.g. Send ↔ Stop, wins over the old one)
    if (el.hasAttribute('title')) {
      if (el.title) el.dataset.tip = el.title;
      el.removeAttribute('title');
    }
    target = el;
    const warm = performance.now() - hiddenAt < WARM;
    timer = window.setTimeout(() => show(el), warm ? 0 : DELAY);
  });
  root.addEventListener('pointerout', (e) => {
    if (target && !target.contains(e.relatedTarget as Node | null)) hide();
  });
  for (const ev of ['pointerdown', 'wheel', 'keydown'] as const) root.addEventListener(ev, hide, true);
  root.addEventListener('scroll', hide, true);
  window.addEventListener('blur', hide);
}
