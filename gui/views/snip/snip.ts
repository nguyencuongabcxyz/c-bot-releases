import type { Box, Point } from '@/types/model';
import { showView } from '@/ui/view';
import markup from './snip.html?raw';
import './snip.css';
import * as ipc from '@/ipc';

showView(markup, { title: 'Drag a box round a word' });

(() => {
  // The drag-a-box screen (main/snip.js): the capture of your screen, dimmed;
  // the box you drag shows through, and on letting go it's cut out and read.
  const shot = document.getElementById('shot') as HTMLImageElement;
  const box = document.getElementById('box')!;
  let from: Point | null = null;
  let rect: Box | null = null;

  const cancel = () => ipc.snipCancel();
  function draw(x: number, y: number) {
    // (only while dragging: from is set)
    rect = { x: Math.min(from!.x, x), y: Math.min(from!.y, y), width: Math.abs(x - from!.x), height: Math.abs(y - from!.y) };
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
    ipc.snipDone(rect);
  });
  document.addEventListener('keydown', (e) => e.key === 'Escape' && cancel());
  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    cancel();
  });

  ipc.snipInit().then((s) => {
    if (!s?.image) return cancel();
    shot.src = s.image;
    if (s.hint) document.getElementById('hint')!.textContent = document.title = s.hint;
  });
})();
