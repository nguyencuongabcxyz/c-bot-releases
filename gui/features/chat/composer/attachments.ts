// Drop (or paste) files on the robot: it reaches out, chomps them, and they
// ride along with the next question.
// (robot.ts calls createAttachments with its hub.)
import { fileIcon } from '@/views/robot/constants';
import { pick } from '@/lib/random';
import type { DeskActivityApi } from '@/views/robot/life/desk';
import type { FaceApi } from '@/views/robot/life/face';
import type { LifeCycleApi } from '@/views/robot/life/lifecycle';
import type { ScreenAskApi } from '@/features/workbench/snip/robot';
import type { BriefsApi } from '../brief';
import type { ChatLogApi } from '../log';
import { Sfx } from '@/views/robot/sound';
import type { RobotState } from '@/views/robot/types';
import * as ipc from '@/ipc';
import { $ } from '@/lib/dom';
import type { FileInfo, Personality } from '@/types/model';
import { Icon } from '@/icons/icons';

/** What it uses of the robot window (robot.ts's hub). */
export type AttachmentsNeeds = {
  readonly body: HTMLElement;
  readonly briefChips: BriefsApi['briefChips'];
  readonly express: FaceApi['express'];
  readonly fill: (line: string) => string;
  readonly flash: FaceApi['flash'];
  readonly input: HTMLTextAreaElement;
  readonly openChat: LifeCycleApi['openChat'];
  readonly persona: () => Personality;
  readonly renderFace: FaceApi['renderFace'];
  readonly renderPose: DeskActivityApi['renderPose'];
  readonly renderScreenAsks: ScreenAskApi['renderScreenAsks'];
  readonly showPop: DeskActivityApi['showPop'];
  readonly state: RobotState;
  readonly strikePose: DeskActivityApi['strikePose'];
  readonly thumbImg: ChatLogApi['thumbImg'];
  readonly wake: LifeCycleApi['wake'];
};

export function createAttachments(r: AttachmentsNeeds) {
  // Drop (or paste) files on the robot: it reaches out, chomps them, and they
  // ride along with the next question.
  r.state.attachments = [];
  const attachRow = $('#attachments');
  // (and the one-click questions about a box of the screen: see “ask about the screen”)
  const screenAsks = $('#screen-asks');
  const PLACEHOLDER = r.input.placeholder;
  let screenShot: { path: string; source: string } | null = null; // { path, source } of the box the chips ask about
  let dragDepth = 0;
  let craving: number | undefined;

  // "325123341_704507901174002_2466761744648938636_n.jpg" -> "325123341_7045…_n.jpg": keeps
  // the start and the extension so the robot's speech bubble stays small
  function shortName(name: string, max = 22) {
    if (name.length <= max) return name;
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 6 ? name.slice(dot - 2) : name.slice(-6);
    return `${name.slice(0, max - ext.length - 1)}…${ext}`;
  }

  function renderAttachments() {
    attachRow.innerHTML = '';
    attachRow.hidden = !r.state.attachments.length && !r.state.briefs.length;
    for (const f of r.state.attachments) {
      const chip = document.createElement('span');
      chip.className = 'file-chip';
      chip.title = f.path;
      chip.innerHTML = `<span></span><button type="button" title="Spit it out">${Icon('x', 'sm')}</button>`;
      $('span', chip).textContent = f.name;
      $('span', chip).dataset.open = f.path; // (the name: a look at it; the ✕ spits it out)
      if (!f.thumb) $('span', chip).insertAdjacentHTML('beforebegin', Icon(fileIcon(f), 'sm'));
      if (f.thumb) chip.prepend(r.thumbImg(f.thumb));
      $('button', chip).addEventListener('click', () => {
        r.state.attachments = r.state.attachments.filter((a) => a !== f);
        renderAttachments();
        r.showPop('Ptooey!', 1200);
        r.input.focus();
      });
      attachRow.appendChild(chip);
    }
    r.briefChips(attachRow, r.state.briefs, (b) => {
      r.state.briefs = r.state.briefs.filter((x) => x !== b);
      renderAttachments();
      r.input.focus();
    });
    r.renderScreenAsks();
  }

  function startCraving() {
    if (r.body.classList.contains('feeding')) return;
    r.body.classList.add('feeding');
    Sfx.key.ooh();
    r.showPop(pick(r.persona().hungry || ['Ooh, snacks?']), 1800);
    const lean = () => {
      r.strikePose('eager', 450);
      r.express('happy', 'wide', 450);
    };
    lean();
    craving = setInterval(lean, 300);
  }

  function stopCraving() {
    r.body.classList.remove('feeding');
    clearInterval(craving);
    r.state.pose = null;
    r.state.face = null;
    r.renderPose();
    r.renderFace();
  }

  // dropped File objects -> [{ path, name, isDir, isImage }]
  async function toEntries(files: File[]) {
    const paths: string[] = [];
    const pasted: Promise<FileInfo | null>[] = [];
    for (const f of files) {
      const p = ipc.pathForFile(f);
      if (p) paths.push(p);
      else if (f.type.startsWith('image/')) {
        pasted.push(ipc.robotSavePaste(new Uint8Array(await f.arrayBuffer()), f.type.split('/')[1]));
      }
    }
    const found = paths.length ? await ipc.robotInspectPaths(paths) : [];
    return [...found, ...((await Promise.all(pasted)).filter(Boolean) as FileInfo[])];
  }

  function eat(entries: FileInfo[]) {
    stopCraving();
    if (!entries.length) {
      r.showPop("Hmm, I can't taste that one.");
      r.express('flat', 'flat', 1200);
      return;
    }
    if (!r.state.awake) r.wake({ sayHi: false });
    else r.openChat(); // show the chips even mid-task
    for (const e of entries) if (!r.state.attachments.some((a) => a.path === e.path)) r.state.attachments.push(e);
    r.state.attachments = r.state.attachments.slice(-20);
    renderAttachments();
    r.flash('chomp', 1300);
    r.express('happy', 'chomp', 1300);
    Sfx.key.chomp();
    const name = entries.length === 1 ? shortName(entries[0].name) : `${entries.length} things`;
    setTimeout(
      () => r.showPop(r.fill(pick(r.persona().yum || ['Yum! {file}!'])).replaceAll('{file}', name), 2400),
      700,
    );
    setTimeout(() => r.express('happy', 'smile', 1200), 1300);
    r.state.lastActivity = Date.now();
    r.input.focus();
  }

  const carriesFiles = (e: DragEvent) => [...(e.dataTransfer?.types || [])].includes('Files');
  document.addEventListener('dragenter', (e) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    startCraving();
  });
  document.addEventListener('dragover', (e) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; // (there is one: it carries files)
  });
  document.addEventListener('dragleave', (e) => {
    if (!carriesFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) {
      stopCraving();
      r.express('flat', 'o', 900); // aww, it went away
    }
  });
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    eat(await toEntries([...(e.dataTransfer?.files || [])]));
  });
  // Ctrl+V anywhere in the window: screenshots and files are eaten, text goes in the chat box
  document.addEventListener('paste', async (e) => {
    const files = [...(e.clipboardData?.files || [])];
    const hasFiles = files.length > 0 || [...(e.clipboardData?.types || [])].includes('Files');
    if (!hasFiles) {
      const text = e.clipboardData?.getData('text');
      if (e.target !== r.input && text && !(e.target as Element).closest?.('input, textarea, [contenteditable]')) {
        e.preventDefault();
        r.input.focus();
        r.input.setRangeText(text, r.input.selectionStart, r.input.selectionEnd, 'end');
        r.input.dispatchEvent(new Event('input'));
      }
      return; // plain text in the chat box pastes as usual
    }
    e.preventDefault();
    startCraving();
    // Files copied in Explorer come without their paths (the webview doesn't tell them):
    // main reads them off the
    // clipboard instead, real paths and all (a picture there is saved, as it would be here).
    if (!files.some((f) => ipc.pathForFile(f))) {
      const fromMain = (await ipc.robotPasteClipboard()) || [];
      if (fromMain.length) return eat(fromMain);
    }
    eat(await toEntries(files));
  });
  // from the robot's right-click menu: works even while it's asleep
  async function pasteClipboard() {
    startCraving();
    eat((await ipc.robotPasteClipboard()) || []);
  }
  return {
    PLACEHOLDER,
    eat,
    pasteClipboard,
    renderAttachments,
    screenAsks,
    get screenShot() {
      return screenShot;
    },
    set screenShot(v) {
      screenShot = v;
    },
  };
}
export type AttachmentsApi = ReturnType<typeof createAttachments>;
