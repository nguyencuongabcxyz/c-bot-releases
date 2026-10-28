// Claude Code stopped to ask something (AskUserQuestion). Show the questions
// as a card with clickable options; the run waits until the answer goes back.
// (robot.ts calls createQuestions with its hub.)
import { THINKING_VERBS } from '@/views/robot/constants';
import { pick } from '@/lib/random';
import type { CommentaryApi } from './reply/commentary';
import type { DeskActivityApi } from '@/views/robot/life/desk';
import type { FaceApi } from '@/views/robot/life/face';
import type { AskingApi } from './reply/ask';
import type { LifeCycleApi } from '@/views/robot/life/lifecycle';
import type { PlansApi } from './plan/card';
import type { TabsApi } from './tabs';
import type { ChatLogApi } from './log';
import { Sfx } from '@/views/robot/sound';
import type { ChatTab, PendingQuestion, RobotState } from '@/views/robot/types';
import * as ipc from '@/ipc';
import { $ } from '@/lib/dom';
import type { Question, RobotView } from '@/types/model';
import { Icon } from '@/icons/icons';

/** What it uses of the robot window (robot.ts's hub). */
export type QuestionsNeeds = {
  readonly active: () => ChatTab | undefined;
  readonly character: () => RobotView;
  readonly animates: CommentaryApi['animates'];
  readonly body: HTMLElement;
  readonly express: FaceApi['express'];
  readonly finishText: AskingApi['finishText'];
  readonly hasSteps: AskingApi['hasSteps'];
  readonly input: HTMLTextAreaElement;
  readonly islandNews: LifeCycleApi['islandNews'];
  readonly moveReply: AskingApi['moveReply'];
  readonly pendingQuestion: PlansApi['pendingQuestion'];
  readonly renderTabs: TabsApi['renderTabs'];
  readonly renderWorking: LifeCycleApi['renderWorking'];
  readonly scrollDown: ChatLogApi['scrollDown'];
  readonly setActivity: DeskActivityApi['setActivity'];
  readonly setTabStatus: CommentaryApi['setTabStatus'];
  readonly showPop: DeskActivityApi['showPop'];
  readonly state: RobotState;
};

export function createQuestions(r: QuestionsNeeds) {
  // Claude Code stopped to ask something (AskUserQuestion). Show the questions
  // as a card with clickable options; the run waits until the answer goes back.
  function askUser({ requestId, questions }: { requestId: string; questions: Question[] }, tab: ChatTab) {
    const cur = tab.current;
    // close the bubble that was streaming, so the answer continues below the card
    if (cur) {
      if (!cur.text.slice(cur.offset || 0).trim() && !r.hasSteps(cur)) cur.el.remove();
      else r.finishText(cur);
    }

    const card = document.createElement('div');
    card.className = 'msg q-card';
    card.innerHTML = '<div class="q-title"></div>';
    $('.q-title', card).textContent =
      `${r.character().name} has ${questions.length > 1 ? `${questions.length} questions` : 'a question'}`;
    const picks = questions.map(() => ({ labels: new Set<string>(), other: '' }));
    const single = questions.length === 1 && !questions[0].multiSelect;
    const blocks: { q: Question; buttons: { b: HTMLButtonElement; label: string }[]; other: HTMLInputElement }[] = [];

    questions.forEach((q, qi) => {
      const block = document.createElement('div');
      block.className = 'q-block';
      if (q.header) {
        const h = document.createElement('div');
        h.className = 'q-header';
        h.textContent = q.header;
        block.appendChild(h);
      }
      const text = document.createElement('div');
      text.className = 'q-text';
      text.textContent = q.question;
      if (q.multiSelect) {
        const m = document.createElement('span');
        m.className = 'q-multi';
        m.textContent = ' (pick any)';
        text.appendChild(m);
      }
      block.appendChild(text);
      const opts = document.createElement('div');
      opts.className = 'q-opts';
      const buttons = (q.options || []).map((o, oi) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'q-opt';
        b.innerHTML = '<span class="q-key"></span><b></b><small></small>';
        $('.q-key', b).textContent = String(oi + 1);
        $('b', b).textContent = o.label;
        $('small', b).textContent = o.description && o.description !== o.label ? o.description : '';
        b.addEventListener('click', () => choose(qi, o.label));
        opts.appendChild(b);
        return { b, label: o.label };
      });
      block.appendChild(opts);
      const other = document.createElement('input');
      other.className = 'q-other';
      other.placeholder = 'Something else… (type and press Enter)';
      other.addEventListener('input', () => {
        picks[qi].other = other.value.trim();
        if (!q.multiSelect && picks[qi].other) picks[qi].labels.clear();
        refresh();
      });
      other.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && other.value.trim()) {
          e.preventDefault();
          if (ready()) send();
        }
      });
      block.appendChild(other);
      card.appendChild(block);
      blocks.push({ q, buttons, other });
    });

    const actions = document.createElement('div');
    actions.className = 'q-actions';
    actions.innerHTML = '<button type="button" class="q-send">Send answer</button><span class="q-hint"></span>';
    const sendBtn = $<HTMLButtonElement>('.q-send', actions);
    $('.q-hint', actions).textContent = single
      ? 'Click an option, press its number, or type below'
      : 'or type your answer below';
    sendBtn.addEventListener('click', () => ready() && send());
    card.appendChild(actions);
    if (single) sendBtn.hidden = true;

    function choose(qi: number, label: string) {
      if (pending.sent) return;
      const p = picks[qi];
      if (blocks[qi].q.multiSelect) {
        p.labels.has(label) ? p.labels.delete(label) : p.labels.add(label);
      } else {
        p.labels = new Set([label]);
        p.other = '';
        blocks[qi].other.value = '';
      }
      Sfx.tool();
      refresh();
      if (single) send();
    }

    const answerOf = (qi: number) => [...picks[qi].labels, ...(picks[qi].other ? [picks[qi].other] : [])].join(', ');
    const ready = () => picks.every((_, qi) => answerOf(qi));

    function refresh() {
      blocks.forEach(({ buttons }, qi) => {
        for (const { b, label } of buttons) b.classList.toggle('on', picks[qi].labels.has(label));
      });
      sendBtn.disabled = !ready();
    }

    async function send() {
      if (pending.sent) return;
      pending.sent = true;
      const answers: Record<string, string> = {};
      const items = questions.map((q, qi) => {
        answers[q.question] = answerOf(qi);
        return { question: q.question, header: q.header, answer: answerOf(qi) };
      });
      card.classList.add('answered');
      for (const el of card.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input')) el.disabled = true;
      Icon.text($('.q-title', card), `✋ You answered ${r.character().name}`);
      const ok = await ipc.robotAnswer(tab.id, requestId, answers, items);
      if (!ok) {
        card.classList.add('expired');
        Icon.text($('.q-title', card), '✋ Too late, that question has closed');
        return;
      }
      handDown(tab, pick(['Got it!', 'Thanks!', 'Noted!', 'Roger that!']));
    }

    const pending: PendingQuestion = {
      sent: false,
      card,
      requestId,
      // composer text answers the first open question; once all are answered it
      // is added to the last one (replacing a single choice, joining a multi-pick)
      typed(text) {
        const open = picks.findIndex((_, i) => !answerOf(i));
        const target = open >= 0 ? open : picks.length - 1;
        blocks[target].other.value = text;
        picks[target].other = text;
        if (!blocks[target].q.multiSelect) picks[target].labels.clear();
        refresh();
        if (ready()) send();
      },
      pickByNumber(n) {
        const qi = Math.max(
          0,
          picks.findIndex((_, i) => !answerOf(i)),
        );
        const opt = blocks[qi].buttons[n - 1];
        if (opt) choose(qi, opt.label);
      },
    };
    tab.question = pending;
    tab.log.appendChild(card);
    refresh();
    r.scrollDown(tab);
    handUp(tab, card, {
      status: 'Waiting for your answer',
      news: questions[0]?.question || 'It has a question for you.',
      away: `“${tab.title}” has a question for you!`,
      here: pick(['Quick question!', 'Psst, I need you!', 'Your call!']),
    });
  }

  // The robot turns round and puts its hand up: a card in the chat waits for you.
  function handUp(tab: ChatTab, card: HTMLElement, say: { status: string; news: string; away: string; here: string }) {
    tab.activity = 'ask';
    r.setTabStatus(tab, `${say.status}…`);
    if (tab.current) tab.current.toolStatus = say.status;
    r.renderTabs();
    Sfx.ask();
    r.express('open', 'o', 1500);
    r.renderWorking(); // it needs you: if the chat is tucked away, the status bubble says so
    r.islandNews('ask', say.news);
    if (r.animates(tab)) {
      r.state.pose = null; // drop any wave or stretch in progress
      r.setActivity('ask');
    }
    if (!r.state.awake) {
      $('#badge').textContent = '?';
      r.body.classList.add('has-badge');
    } else if (tab !== r.active()) {
      r.showPop(say.away, 2600);
    } else {
      r.showPop(say.here, 1800);
      card.querySelector<HTMLElement>('.q-opt, .q-other')?.focus();
    }
  }

  // You answered its card: hand down, back to work, the rest of the answer below the card.
  function handDown(tab: ChatTab, pop: string) {
    tab.question = null;
    if (!r.pendingQuestion()) {
      r.body.classList.remove('has-badge');
      $('#badge').textContent = '!';
    }
    Sfx.key.send();
    r.express('happy', 'smile', 1400);
    r.showPop(pop, 1500);
    tab.activity = 'think';
    if (r.animates(tab)) r.setActivity('think');
    r.setTabStatus(tab, `${pick(THINKING_VERBS)}…`);
    r.renderTabs();
    // the rest of the answer streams into a fresh bubble below the card
    if (tab.current) {
      const el = document.createElement('div');
      el.className = 'msg bot';
      tab.log.appendChild(el);
      r.moveReply(tab.current, el, tab.current.text.length);
    }
    r.scrollDown(tab);
    r.input.focus();
  }
  return { askUser, handDown, handUp };
}
export type QuestionsApi = ReturnType<typeof createQuestions>;
