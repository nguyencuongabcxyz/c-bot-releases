// A box you dragged round part of the screen (main: askScreen): it opens a fresh tab with
// the screenshot attached, and offers a few one-click questions above the box, or you type
// your own. The chips go once the screenshot's sent or spat out.
// (robot.ts calls createScreenAsk with its hub.)
import { pick } from '@/lib/random';
import type { DeskActivityApi } from '@/views/robot/life/desk';
import type { FaceApi } from '@/views/robot/life/face';
import type { LifeCycleApi } from '@/views/robot/life/lifecycle';
import type { AttachmentsApi } from '@/features/chat/composer/attachments';
import type { AskingApi } from '@/features/chat/reply/ask';
import { Sfx } from '@/views/robot/sound';
import type { ChatTab, RobotState } from '@/views/robot/types';
import * as ipc from '@/ipc';
import { $ } from '@/lib/dom';
import type { FileInfo } from '@/types/model';
import { Icon } from '@/icons/icons';

/** What it uses of the robot window (robot.ts's hub). */
export type ScreenAskNeeds = {
  readonly current: () => ChatTab;
  readonly activeId: string | null;
  readonly express: FaceApi['express'];
  readonly flash: FaceApi['flash'];
  readonly input: HTMLTextAreaElement;
  readonly openChat: LifeCycleApi['openChat'];
  readonly PLACEHOLDER: AttachmentsApi['PLACEHOLDER'];
  readonly renderAttachments: AttachmentsApi['renderAttachments'];
  readonly screenAsks: AttachmentsApi['screenAsks'];
  screenShot: { path: string; source: string } | null;
  readonly showPop: DeskActivityApi['showPop'];
  readonly state: RobotState;
  readonly strikePose: DeskActivityApi['strikePose'];
  readonly submit: AskingApi['submit'];
  readonly wake: LifeCycleApi['wake'];
};

export function createScreenAsk(rw: ScreenAskNeeds) {
  // A box you dragged round part of the screen (main: askScreen): it opens a fresh tab with
  // the screenshot attached, and offers a few one-click questions above the box, or you type
  // your own. The chips go once the screenshot's sent or spat out.
  const SCREEN_ASKS = [
    ['bulb', 'Explain this', 'Explain what this shows.'],
    ['wrench', "What's wrong?", "What's wrong here, and how do I fix it?"],
    ['languages', 'Translate', 'Translate the text in this into Vietnamese.'],
    ['summary', 'Sum it up', 'Sum this up in a few short bullet points.'],
  ];

  function renderScreenAsks() {
    const shot = rw.screenShot;
    const on = !!shot && rw.state.attachments.some((a) => a.path === shot.path);
    if (!on) rw.screenShot = null;
    rw.input.placeholder = on ? 'Ask about this… (or pick one)' : rw.PLACEHOLDER;
    if (on === !rw.screenAsks.hidden) return;
    rw.screenAsks.hidden = !on;
    rw.screenAsks.innerHTML = '';
    if (!on) return;
    const label = document.createElement('span');
    label.className = 'sa-label';
    label.textContent = 'Ask';
    rw.screenAsks.append(label);
    SCREEN_ASKS.forEach(([icon, text, prompt], i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = Icon(icon, 'sm lead');
      b.append(text);
      b.style.animationDelay = `${i * 40}ms`;
      b.addEventListener('click', () => {
        if (rw.current().busy) return rw.showPop('One thing at a time! 😅', 1500);
        const typed = rw.input.value.trim();
        rw.input.value = [prompt, typed, rw.screenShot?.source ? `(It's from: ${rw.screenShot.source})` : '']
          .filter(Boolean)
          .join('\n\n');
        rw.submit();
      });
      rw.screenAsks.append(b);
    });
  }

  async function onScreen({ file, source = '' }: { file: FileInfo; source?: string }) {
    if (!file?.path || rw.state.away) return;
    if (!rw.state.awake) rw.wake({ sayHi: false });
    else rw.openChat();
    // a fresh tab, unless the one you're on is new and empty
    const tab = rw.current();
    if (tab.busy || tab.log.querySelector('.msg.user')) {
      const res = await ipc.robotTabNew();
      if (res.ok) for (let i = 0; i < 60 && rw.activeId !== res.tabId; i++) await new Promise((r) => setTimeout(r, 50));
    }
    rw.screenShot = { path: file.path, source };
    rw.state.attachments = [...rw.state.attachments.filter((a) => a.path !== file.path), file].slice(-20);
    rw.renderAttachments();
    rw.flash('hop', 600);
    rw.express('wide', 'o', 900);
    Sfx.key.ooh();
    rw.showPop(pick(['Ooh, let me see! 🔍', 'What have we got here? 👀', 'Show me! 🔍']), 1800);
    rw.state.lastActivity = Date.now();
    rw.input.focus();
  }
  ipc.on('robot:screen', onScreen);

  // the action menu's hotkey (main: openPalette): it sends its drone off to you with a wave
  ipc.on('robot:palette', (ev) => {
    if (ev.phase !== 'launch' || rw.state.away || !rw.state.awake || rw.state.busy) return;
    rw.strikePose('raise', 700);
    rw.express('happy', 'o', 700);
    Sfx.whee();
  });
  $('#btn-screen').addEventListener('click', () => ipc.robotScreenAsk());

  // Speaking instead of typing (workbench/voice.rs): the system's own dictation types into the box (on
  // Windows its voice typing, Win+H, with its own bar showing it listen). No engine, no mic.
  const micBtn = $('#btn-mic');
  ipc.voiceEngine().then(
    (v) => {
      if (!v.name) return;
      micBtn.hidden = false;
      if (v.name === 'windows-voice-typing') micBtn.title = 'Speak instead of typing (Windows voice typing, Win+H)';
    },
    () => {},
  );
  micBtn.addEventListener('mousedown', (e) => e.preventDefault()); // (the box keeps the keyboard, and where you were in it)
  micBtn.addEventListener('click', async () => {
    if (document.activeElement !== rw.input) {
      rw.input.focus();
      rw.input.setSelectionRange(rw.input.value.length, rw.input.value.length);
    }
    micBtn.classList.add('on');
    setTimeout(() => micBtn.classList.remove('on'), 1600);
    try {
      await ipc.voiceStart();
      rw.showPop('🎙️ Listening… say it, I’ll type it', 2200);
    } catch (err) {
      rw.showPop(String(err), 2400);
    }
  });
  return { renderScreenAsks };
}
export type ScreenAskApi = ReturnType<typeof createScreenAsk>;
