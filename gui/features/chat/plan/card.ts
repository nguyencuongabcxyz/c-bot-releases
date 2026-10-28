// In plan mode Claude looks around, changes nothing, and comes back with a plan
// (ExitPlanMode). The plan shows as a card: go ahead (it carries on building, in the
// mode you pick), or keep planning, with notes on what to change.
// (robot.ts calls createPlans with its hub.)
import { pick } from '@/lib/random';
import type { BrainApi } from '../brain';
import type { ComposerApi } from '../composer/composer';
import type { AskingApi } from '../reply/ask';
import type { FaceApi } from '@/views/robot/life/face';
import type { QuestionsApi } from '../questions';
import type { SlashApi } from '../composer/slash';
import type { ChatMarkdownApi } from '../reply/local-files';
import type { ChatLogApi } from '../log';
import type { ChatTab, PendingQuestion, RobotState } from '@/views/robot/types';
import { GO_LABEL, planNotes } from './modes';
import * as ipc from '@/ipc';
import { $ } from '@/lib/dom';
import type { PermissionMode, QAItem, RobotView } from '@/types/model';
import { Icon } from '@/icons/icons';

/** What it uses of the robot window (robot.ts's hub). */
export type PlansNeeds = {
  readonly active: () => ChatTab | undefined;
  readonly current: () => ChatTab;
  readonly character: () => RobotView;
  readonly autosize: ComposerApi['autosize'];
  readonly finishText: AskingApi['finishText'];
  readonly flash: FaceApi['flash'];
  readonly handDown: QuestionsApi['handDown'];
  readonly handUp: QuestionsApi['handUp'];
  readonly hasSteps: AskingApi['hasSteps'];
  readonly hidePalette: SlashApi['hidePalette'];
  readonly input: HTMLTextAreaElement;
  readonly md: ChatMarkdownApi['md'];
  readonly renderBrain: BrainApi['renderBrain'];
  readonly scrollDown: ChatLogApi['scrollDown'];
  readonly state: RobotState;
  readonly tabs: Map<string, ChatTab>;
};

export function createPlans(r: PlansNeeds) {
  // In plan mode Claude looks around, changes nothing, and comes back with a plan
  // (ExitPlanMode). The plan shows as a card: go ahead (it carries on building, in the
  // mode you pick), or keep planning, with notes on what to change.
  function reviewPlan({ requestId, plan, file }: { requestId: string; plan: string; file: string }, tab: ChatTab) {
    const cur = tab.current;
    if (cur) {
      if (!cur.text.slice(cur.offset || 0).trim() && !r.hasSteps(cur)) cur.el.remove();
      else r.finishText(cur);
    }
    const card = document.createElement('div');
    card.className = 'msg q-card plan-card';
    card.innerHTML = `<div class="q-title">${Icon('plan', 'sm lead')}<span></span></div><div class="plan-body"></div>`;
    $('.q-title span', card).textContent = `${r.character().name}'s plan`;
    $('.plan-body', card).innerHTML = r.md(plan || '_(an empty plan)_');
    if (file) {
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'plan-file';
      open.dataset.open = file; // (opens in the chat's file view)
      open.innerHTML = `${Icon('file', 'sm')}<span></span>`;
      $('span', open).textContent = file.split(/[\\/]/).pop() ?? '';
      card.appendChild(open);
    }
    const ask = document.createElement('div');
    ask.className = 'q-text';
    ask.textContent = 'Go ahead with this plan?';
    card.appendChild(ask);

    // going ahead: with edits accepted, or (where the robot is trusted with it) full access
    const choices: { mode: PermissionMode | null; label: string; desc: string }[] = [
      {
        mode: 'acceptEdits',
        label: 'Yes, and auto-accept edits',
        desc: 'I build it, editing files in my folder without asking',
      },
      ...(tab.canBypass
        ? [
            {
              mode: 'bypassPermissions' as PermissionMode,
              label: 'Yes, with full access',
              desc: 'I build it, running anything I need',
            },
          ]
        : []),
      { mode: null, label: 'No, keep planning', desc: 'Tell me what to change' },
    ];
    const opts = document.createElement('div');
    opts.className = 'q-opts';
    const buttons = choices.map((c, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'q-opt';
      b.innerHTML = '<span class="q-key"></span><b></b><small></small>';
      $('.q-key', b).textContent = String(i + 1);
      $('b', b).textContent = c.label;
      $('small', b).textContent = c.desc;
      b.addEventListener('click', () => (c.mode ? decide(c.mode) : keepPlanning()));
      opts.appendChild(b);
      return b;
    });
    card.appendChild(opts);
    const notes = document.createElement('textarea');
    notes.className = 'q-other plan-notes-input';
    notes.rows = 2;
    notes.placeholder = 'What should change? (Enter sends it back, Shift+Enter for a new line)';
    notes.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        decide(null, notes.value);
      }
    });
    card.appendChild(notes);

    // "No": the notes box first; a second "No" (or Enter there) sends it back
    function keepPlanning() {
      if (notes.value.trim() || card.classList.contains('noting')) return decide(null, notes.value);
      card.classList.add('noting');
      buttons[buttons.length - 1].classList.add('on');
      notes.focus();
    }

    async function decide(mode: PermissionMode | null, feedback = '') {
      if (pending.sent) return;
      pending.sent = true;
      feedback = feedback.trim();
      buttons[mode ? choices.findIndex((c) => c.mode === mode) : buttons.length - 1].classList.add('on');
      card.classList.add('answered');
      const fields = card.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement>('button:not(.plan-file), textarea');
      for (const el of fields) el.disabled = true;
      const res = await ipc.robotPlan(tab.id, requestId, plan, mode, feedback);
      const title = $('.q-title span', card);
      if (!res.ok) {
        card.classList.add('expired');
        title.textContent = res.error ? `Couldn't go ahead: ${res.error}` : 'Too late, that plan has closed';
        return;
      }
      if (mode) {
        tab.mode = mode;
        if (tab === r.active()) r.renderBrain();
        title.textContent = `Plan approved, ${GO_LABEL[mode]}`;
        r.flash('hop', 600);
      } else {
        title.textContent = 'Plan sent back for changes';
        if (feedback) card.appendChild(planNotes(feedback));
      }
      r.handDown(
        tab,
        mode
          ? pick(['Building it!', 'On it!', 'Here we go!', 'Hammer time!'])
          : pick(['Back to the drawing board!', 'Let me rethink…', 'Noted!']),
      );
    }

    const pending: PendingQuestion = {
      sent: false,
      card,
      requestId,
      closed: 'This plan closed before you decided',
      // typing in the composer: notes on what to change, and it goes back for another go
      typed(text) {
        decide(null, text);
      },
      pickByNumber(n) {
        buttons[n - 1]?.click();
      },
    };
    tab.question = pending;
    tab.log.appendChild(card);
    r.scrollDown(tab);
    r.handUp(tab, card, {
      status: 'Waiting for your go-ahead',
      news: 'It has a plan for you to look over.',
      away: `“${tab.title}” has a plan for you!`,
      here: pick(['Here’s my plan!', 'Plan ready!', 'Have a look!']),
    });
  }

  const pendingQuestion = () => [...r.tabs.values()].find((t) => t.question && !t.question.sent);

  function answerFromComposer(text: string) {
    r.input.value = '';
    r.autosize();
    r.hidePalette();
    r.current().question?.typed(text); // (only while its question waits)
  }

  // the run ended (or was stopped) before the question was answered
  function expireQuestion(tab: ChatTab) {
    const q = tab.question;
    tab.question = null;
    if (!pendingQuestion()) $('#badge').textContent = '!';
    if (!q || q.sent) return;
    q.card.classList.add('expired');
    for (const el of q.card.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input')) el.disabled = true;
    if (q.closed) $('.q-title span', q.card).textContent = q.closed;
    else Icon.text($('.q-title', q.card), '✋ This question closed without an answer');
  }

  function addQaSummary(items: QAItem[] = [], tab: ChatTab = r.current()) {
    for (const it of items) {
      const el = document.createElement('div');
      el.className = 'msg qa-summary';
      el.innerHTML = `${Icon('hand', 'sm lead')}<span></span> → <b></b>`;
      $('span', el).textContent = it.question;
      $('b', el).textContent = it.answer;
      tab.log.appendChild(el);
    }
    r.scrollDown(tab);
  }
  return { addQaSummary, answerFromComposer, expireQuestion, pendingQuestion, reviewPlan };
}
export type PlansApi = ReturnType<typeof createPlans>;
