// The running commentary: the status line while it works, notes in the chat, and what it
// thinks aloud in a bubble beside it.
// (robot.ts calls createCommentary with its hub.)
import { ROBOT_H } from '@/views/robot/constants';
import type { LifeCycleApi } from '@/views/robot/life/lifecycle';
import type { ChatLogApi } from '../log';
import type { ChatTab, RobotState } from '@/views/robot/types';
import { tokens as fmtTokens } from './steps';
import { $ } from '@/lib/dom';
import { Icon } from '@/icons/icons';

/** What it uses of the robot window (robot.ts's hub). */
export type CommentaryNeeds = {
  readonly active: () => ChatTab | undefined;
  readonly current: () => ChatTab;
  readonly body: HTMLElement;
  readonly renderWorking: LifeCycleApi['renderWorking'];
  readonly scrollDown: ChatLogApi['scrollDown'];
  readonly state: RobotState;
  readonly statusMeta: HTMLElement;
  readonly statusRow: HTMLElement;
  readonly statusText: HTMLElement;
};

export function createCommentary(r: CommentaryNeeds) {
  // (mcp/apps.ts)

  const asideEl = $('#aside');
  let asideTimer = 0;
  function showAside(text: string) {
    asideEl.textContent = text;
    asideEl.hidden = false;
    asideEl.classList.remove('show', 'right', 'compact');
    void asideEl.offsetWidth;
    const robotH = ROBOT_H * (r.state.scale || 1);
    if (r.state.collapsed) {
      // chat tucked away: in the strip above (or below) the robot, clear of the desk
      const h = asideEl.offsetHeight;
      asideEl.classList.add('right');
      asideEl.style.left = '8px';
      // next to the status bubble, which sits right against the robot
      asideEl.style.top = `${r.state.placement === 'tuck-below' ? r.state.robotY + robotH + 50 : Math.max(2, r.state.robotY - h - 56)}px`;
    } else if (!r.body.classList.contains('expanded')) {
      // a small window with no room around the robot: the remark is in the chat anyway
      asideEl.hidden = true;
      return;
    } else {
      // above the robot's head, clear of the chat beside it (or tucked into the
      // robot's corner when the robot is right at the top of the screen)
      const w = asideEl.offsetWidth;
      const h = asideEl.offsetHeight;
      asideEl.classList.add('right');
      asideEl.style.left = `${Math.max(8, Math.min(r.state.robotX + 20, innerWidth - w - 8))}px`;
      asideEl.style.top = `${r.state.robotY - h - 30 >= 8 ? r.state.robotY - h - 30 : r.state.robotY + robotH + 12}px`; // below it at the top of the screen
    }
    asideEl.classList.add('show');
    clearTimeout(asideTimer);
    asideTimer = setTimeout(
      () => {
        asideEl.classList.remove('show');
        setTimeout(() => (asideEl.hidden = !asideEl.classList.contains('show')), 300);
      },
      3800 + text.length * 45,
    );
  }

  function addNote(text: string, cls = '', tab: ChatTab = r.current()) {
    const el = document.createElement('div');
    el.className = `msg note ${cls}`;
    Icon.text(el, text);
    tab.log.appendChild(el);
    r.scrollDown(tab);
  }

  function deniedNote(denials: string[]) {
    const el = document.createElement('div');
    el.className = 'denied';
    Icon.text(
      el,
      `🔒 I wasn't allowed to use ${[...new Set(denials)].join(', ')}. Right-click me → Permissions to give me more power.`,
    );
    return el;
  }

  // (the status line and strip are plain mono text: no leading emoji)
  function plain(text: string) {
    return String(text || '').replace(/^(?:\p{Extended_Pictographic}|\uFE0F|\u200D)+\s*/u, '');
  }
  function setStatus(text: string) {
    r.statusRow.hidden = !text;
    r.statusText.textContent = plain(text);
    renderMeta();
  }
  // after what it's doing, as Claude Code shows it: "(12s · ↓ 1.2k tokens · esc to stop)"
  function renderMeta() {
    const t = r.active();
    if (!t?.busy || !t.turnStart || t.question) {
      r.statusMeta.textContent = '';
      return;
    }
    const s = Math.max(0, Math.round((Date.now() - t.turnStart) / 1000));
    const time = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
    const n = Math.max(t.outTokens || 0, Math.round((t.outChars || 0) / 4)); // (what it says, or an estimate as it streams)
    r.statusMeta.textContent = `(${time}${n ? ` · ↓ ${fmtTokens(n)} tokens` : ''} · esc to stop)`;
  }
  setInterval(() => !r.statusRow.hidden && renderMeta(), 1000);

  // each tab keeps its own status line; only the visible one is shown
  function setTabStatus(tab: ChatTab, text: string) {
    tab.statusText = text || '';
    if (tab === r.active()) setStatus(text);
    r.renderWorking();
  }

  // does the robot act out this tab's events? The tab you're looking at always;
  // a background tab only while the visible one is idle.
  const animates = (tab: ChatTab) => tab === r.active() || !r.active()?.busy;
  return { addNote, animates, deniedNote, plain, renderMeta, setStatus, setTabStatus, showAside };
}
export type CommentaryApi = ReturnType<typeof createCommentary>;
