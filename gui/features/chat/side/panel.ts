// Side questions about an answer (chat/side/threads.ts), wired to this window: its tabs, its markdown,
// and the stage (no side panel on a stage tile).
// (robot.ts calls createSidePanel with its hub.)
import type { ComposerApi } from '../composer/composer';
import type { ChatMarkdownApi } from '../reply/local-files';
import type { DeskActivityApi } from '@/views/robot/life/desk';
import type { StageApi } from '@/features/robots/stage/tile';
import type { ChatTab } from '@/views/robot/types';
import { SideQuestions } from './threads';

/** What it uses of the robot window (robot.ts's hub). */
export type SidePanelNeeds = {
  readonly autosize: ComposerApi['autosize'];
  readonly input: HTMLTextAreaElement;
  readonly md: ChatMarkdownApi['md'];
  readonly showPop: DeskActivityApi['showPop'];
  readonly stagePart: StageApi;
  readonly tabs: Map<string, ChatTab>;
};

export function createSidePanel(r: SidePanelNeeds) {
  const sides = SideQuestions({
    md: r.md,
    tabOf: (id) => r.tabs.get(id),
    staged: () => r.stagePart.staged,
    // a side answer taken back to the conversation: into the box, to send (or not)
    useInMain: (text) => {
      const had = r.input.value.trimEnd();
      r.input.value = had ? `${had}\n\n${text}` : text;
      r.autosize();
      r.input.focus();
      r.input.setSelectionRange(r.input.value.length, r.input.value.length);
    },
    showPop: r.showPop,
  });
  return { sides };
}
export type SidePanelApi = ReturnType<typeof createSidePanel>;
