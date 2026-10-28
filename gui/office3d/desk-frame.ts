// The desk, every frame: the monitor (redrawn only when it changes), the word box and the sticky
// notes on the monitor, a paper plane that landed, the corkboard with your notes, the hammer and
// the plug lit up under the mouse.
import { ease, mix } from './core/math';
import { buildPaperPlane } from './plane3d';
import { type OfficeData, readJson } from './protocol';
import { drawScreen, SCREEN_LIGHT } from './screens';
import type { buildProps } from './props';
import type { buildHammer } from './hammer';
import type { AnticPose } from './antics/types';
import type { Board, OfficeSet, Theme } from './types';

const STILL_SCREENS = new Set(['off', 'error']); // monitor scenes that don't move (screens/)

/** What it takes from each frame. */
export type DeskFrame = {
  now: number;
  t: number;
  dt: number;
  d: OfficeData;
  A: AnticPose;
  gone: boolean;
  goneAt: number;
  /** the monitor scene the page asked for */
  screen: string;
  screenStart: number;
  anticStart: number;
  paint: string;
  theme: Theme;
  themeKey: string;
  lights: number;
  night: number;
  set: OfficeSet;
  board: Board | null;
  props: ReturnType<typeof buildProps> | null;
  toy: ReturnType<typeof buildHammer> | null;
  since: (reaction: string) => number;
};

export function createDeskFrame() {
  const screenDrawn: { set: OfficeSet | null; key: string; at: number } = { set: null, key: '', at: 0 }; // what the monitor's canvas shows, and when it was drawn
  let shownWords = -1; // the word box shows this many (and wordsSet is the desk it's on)
  let wordsSet: OfficeSet | null = null;
  let shownStickies = '';
  let deskPlane: ReturnType<typeof buildPaperPlane> | null = null; // a paper plane that landed on the desk (data-desk-plane)
  let shownVisit = ''; // the visitor's sticky (data-visit-notes), and the desk it's on
  let visitSet: OfficeSet | null = null;
  let stickiesMoving = false; // a sticky note zooming up or back (scene.js stickies.update)

  let boardKey: string | null = null; // the notes it shows, as drawn (data-board, JSON)

  function update({
    now,
    t,
    dt,
    d,
    A,
    gone,
    goneAt,
    screen,
    screenStart,
    anticStart,
    paint,
    theme,
    themeKey,
    lights,
    night,
    set,
    board,
    props,
    toy,
    since,
  }: DeskFrame) {
    // ---- monitor
    // (an antic may borrow it: a screensaver, a dream on the dark screen; out for a walk: a BRB note)
    const shown = gone ? 'brb' : A.screen || screen;
    // redrawn (and sent to the GPU) only when it changes: a still scene once, a moving one
    // at up to 20 fps
    const dim = A.screen && A.screenDim > 0 ? A.screenDim : 0;
    const screenKey = `${shown}|${paint}|${themeKey}|${dim.toFixed(2)}`;
    if (
      set !== screenDrawn.set ||
      screenKey !== screenDrawn.key ||
      (!STILL_SCREENS.has(shown) && now - screenDrawn.at >= 48)
    ) {
      drawScreen(
        set.screen.ctx,
        shown,
        gone ? t - goneAt : A.screen ? t - anticStart : t - screenStart,
        paint || '#5ac8fa',
        theme,
      ); // (goneAt: set as it went)
      if (dim) {
        set.screen.ctx.fillStyle = `rgba(0,0,0,${dim})`;
        set.screen.ctx.fillRect(0, 0, set.screen.canvas.width, set.screen.canvas.height);
      }
      set.screen.tex.needsUpdate = true;
      screenDrawn.set = set;
      screenDrawn.key = screenKey;
      screenDrawn.at = now;
    }
    const glowColor = SCREEN_LIGHT[shown.split(':')[0]] || (A.screen ? '#9fb0ff' : null);
    // (the BRB note glows softly in a dark room, so the desk still reads asleep)
    const glow = glowColor ? 1.4 * (1 - A.screenDim) * (gone ? mix(0.35, 1, lights) : 1) : 0;
    set.screen.light.intensity = mix(set.screen.light.intensity, glow + 1.6 * night, ease(dt, 6));
    if (glowColor) set.screen.light.color.set(glowColor);
    set.screen.led.material.color.set(screen === 'off' ? (Math.sin(t * 2.5) > 0 ? '#ffb347' : '#5a4630') : '#7bed9f');

    // ---- the English word box on the desk (robot.js: data-vocab-count), and the words
    // you're learning on sticky notes on the monitor (data-vocab-stickies: JSON [{ id, text, sub }])
    const words = Number(d.vocabCount) || 0;
    const stickyJson = d.vocabStickies || '';
    if (words !== shownWords || set !== wordsSet || stickyJson !== shownStickies) {
      shownWords = words;
      wordsSet = set;
      shownStickies = stickyJson;
      set.wordBox?.setCount(words);
      set.stickies?.set('vocab', readJson<'vocabStickies'>(stickyJson, []));
    }
    // a visitor found it asleep: a "came by" sticky on the monitor's other edge (robot.js:
    // data-visit-notes, JSON [{ id, text, sub, color }])
    if ((d.visitNotes || '') !== shownVisit || set !== visitSet) {
      shownVisit = d.visitNotes || '';
      visitSet = set;
      set.stickies?.set('note', readJson<'visitNotes'>(shownVisit, []));
    }
    // a paper plane another robot threw, landed (on top of its monitor, in sight whether it
    // sits or sleeps in the chair or on the floor) while it was busy or asleep
    // (robot.js: data-desk-plane '1'; it picks it up and reads it when it's free)
    const top = set.desk?.top || set.office;
    if (d.deskPlane === '1' && deskPlane?.parent !== top) {
      deskPlane ||= buildPaperPlane();
      deskPlane.position.set(-0.36, 1.83, -1.19);
      deskPlane.rotation.set(0.04, 0.55, 0.12);
      deskPlane.scale.setScalar(1.6);
      top.add(deskPlane);
    } else if (d.deskPlane !== '1' && deskPlane?.parent) deskPlane.removeFromParent();
    // the word note under the mouse pops up bigger (robot.js: data-sticky-hover)
    set.stickies?.hover(d.stickyHover ? 'vocab' : '', d.stickyHover || '');
    stickiesMoving = !!set.stickies?.update(dt);

    // ---- the corkboard: your open notes (data-board: JSON { items, total, hidden }), lit up
    // while the mouse is on it (data-board-hover), held up for a reminder (A.boardLift)
    if (board) {
      const json = d.board || '';
      if (json !== boardKey) {
        boardKey = json;
        const b = readJson<'board'>(json, { items: [], total: 0 });
        board.group.visible = !b.hidden;
        board.setNotes(b.items || [], b.total || 0);
      }
      board.setHover(d.propHover === 'board');
      board.setLift(A.boardLift || 0);
      board.update(t, dt);
    }
    // ---- the hammer and the plug: lit up under the mouse (data-prop-hover), the hammer
    // picked up while it bonks, the plug buzzing while it charges
    if (props) {
      props.setHover(d.propHover);
      props.update(t, dt, { bonking: toy?.hammer.visible, charging: since('charge') < 2.2 });
    }
  }
  return {
    update,
    /** a sticky note zooming up or back (the frame rate stays up meanwhile) */
    get stickiesMoving() {
      return stickiesMoving;
    },
    /** the corkboard was built again: pin the notes up again */
    repinBoard() {
      boardKey = null;
    },
  };
}
