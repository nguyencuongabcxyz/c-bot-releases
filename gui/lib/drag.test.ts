import { beforeEach, describe, expect, test, vi } from 'vitest';
import { type DragAt, onDrag } from './drag';

// (jsdom has no pointer capture)
HTMLElement.prototype.setPointerCapture = () => {};

let box: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = '<div id="box"></div>';
  box = document.getElementById('box') as HTMLElement;
});

const fire = (type: string, x = 0, y = 0, button = 0) =>
  box.dispatchEvent(new PointerEvent(type, { screenX: x, screenY: y, button, pointerId: 1, bubbles: true }));

describe('onDrag', () => {
  test('moves from the press, then ends once', () => {
    const moves: DragAt[] = [];
    const end = vi.fn();
    onDrag(box, () => ({ move: (d) => moves.push(d), end }));
    fire('pointerdown', 100, 100);
    fire('pointermove', 110, 95);
    fire('pointerup', 120, 90);
    fire('lostpointercapture', 120, 90);
    expect(moves.map((d) => [d.dx, d.dy, d.moved])).toEqual([[10, -5, true]]);
    expect(end).toHaveBeenCalledTimes(1);
    expect(end.mock.calls[0][0]).toMatchObject({ dx: 20, dy: -10, moved: true, letGo: true });
  });

  test('under the threshold it is a click: no begin, no move, end not moved', () => {
    const begin = vi.fn();
    const move = vi.fn();
    const end = vi.fn();
    onDrag(box, () => ({ begin, move, end }), { threshold: 5 });
    fire('pointerdown', 0, 0);
    fire('pointermove', 3, 3);
    fire('pointerup', 3, 3);
    expect(begin).not.toHaveBeenCalled();
    expect(move).not.toHaveBeenCalled();
    expect(end.mock.calls[0][0].moved).toBe(false);
  });

  test('begin once, as it passes the threshold, before its first move', () => {
    const calls: string[] = [];
    onDrag(box, () => ({ begin: () => calls.push('begin'), move: (d) => calls.push(`move ${d.dx}`) }), {
      threshold: 5,
    });
    fire('pointerdown', 0, 0);
    fire('pointermove', 6, 0);
    fire('pointermove', 8, 0);
    expect(calls).toEqual(['begin', 'move 6', 'move 8']);
  });

  test('a cancelled drag ends too, and nothing moves after it', () => {
    const move = vi.fn();
    const end = vi.fn();
    onDrag(box, () => ({ move, end }));
    fire('pointerdown');
    fire('pointercancel');
    fire('pointermove', 50, 50);
    expect(end).toHaveBeenCalledTimes(1);
    expect(end.mock.calls[0][0].letGo).toBe(false);
    expect(move).not.toHaveBeenCalled();
  });

  test('only the left button, and only when start says so', () => {
    const start = vi.fn(() => undefined);
    onDrag(box, start);
    fire('pointerdown', 0, 0, 2);
    expect(start).not.toHaveBeenCalled();
    fire('pointerdown');
    expect(start).toHaveBeenCalledTimes(1);
  });
});
