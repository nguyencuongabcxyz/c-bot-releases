(() => {
  // The drag-a-box screen (main/snip.js): the capture of your screen, dimmed;
  // the box you drag shows through, and on letting go it's cut out and read.
  const shot = document.getElementById('shot');
  const box = document.getElementById('box');
  let from = null;
  let rect = null;

  const cancel = () => cbot.invoke('snip:cancel');
  function draw(x, y) {
    rect = { x: Math.min(from.x, x), y: Math.min(from.y, y), width: Math.abs(x - from.x), height: Math.abs(y - from.y) };
    Object.assign(box.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  }

  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return cancel();
    from = { x: e.clientX, y: e.clientY };
    rect = null;
    document.body.classList.add('dragging');
    draw(e.clientX, e.clientY);
    document.body.setPointerCapture(e.pointerId);
  });
  document.addEventListener('pointermove', (e) => from && draw(e.clientX, e.clientY));
  document.addEventListener('pointerup', () => {
    if (!from) return;
    from = null;
    if (!rect || rect.width < 6 || rect.height < 6) return cancel(); // a click, not a box
    cbot.invoke('snip:done', rect);
  });
  document.addEventListener('keydown', (e) => e.key === 'Escape' && cancel());
  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    cancel();
  });

  cbot.invoke('snip:init').then((s) => {
    if (!s?.image) return cancel();
    shot.src = s.image;
    if (s.hint) document.getElementById('hint').textContent = document.title = s.hint;
  });
})();
