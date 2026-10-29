// The robot window: the robot at its desk (office3d) and its chat. This file holds the shared
// state and calls each part in turn (its own life/, and features/: chat, notes, vocab,
// workbench, robots, mcp), handing it the hub: what it takes from the rest, read when used.
// Then it listens to main and starts up.
import { ROBOT_H, ROBOT_W } from './constants';
import { rand } from '@/lib/random';
import { $ } from '@/lib/dom';
import { Office3D } from '@/office3d';
import { officeData } from '@/office3d/protocol';
import { Icon } from '@/icons/icons';
import { Sfx } from './sound';
import { tooltips } from '@/features/chat/tips';
import { showView } from '@/lib/page';
import markup from './robot.html?raw';
import '@/theme/theme.css';
import '@/theme/base.css';
import './robot.css';
import '@/features/chat/chat.css';
import '@/features/robots/stage/tile.css';
import type { Settings } from '@/types/model';
import * as ipc from '@/ipc';

import type { ChatTab, RobotState } from './types';
import { createTodoCard, type TodoCardApi } from '@/features/chat/todo';
import { createHandedOffTasks } from '@/features/robots/link/tasks';
import { createRobotMessages, type RobotMessagesApi } from '@/features/robots/link/asks';
import { createOtherRobots, type OtherRobotsApi } from '@/features/robots/reactions';
import { createScreenAsk, type ScreenAskApi } from '@/features/workbench/snip/robot';
import { createNotes, type NotesApi } from '@/features/notes/robot';
import { createRoutines, type RoutinesApi } from '@/features/routines/robot';
import { createVocab, type VocabApi } from '@/features/vocab/robot';
import { createStage, type StageApi } from '@/features/robots/stage/tile';
import { createIdleAntics, type IdleAnticsApi } from './life/antics';
import { createMentions, type MentionsApi } from '@/features/chat/composer/mentions';
import { createSlash, type SlashApi } from '@/features/chat/composer/slash';
import { createBrain, type BrainApi } from '@/features/chat/brain';
import { createBonk, type BonkApi } from './life/bonk';
import { createAttachments, type AttachmentsApi } from '@/features/chat/composer/attachments';
import { createBriefs, type BriefsApi } from '@/features/chat/brief';
import { createPlans, type PlansApi } from '@/features/chat/plan/card';
import { createQuestions, type QuestionsApi } from '@/features/chat/questions';
import { createRemoteControl, type RemoteControlApi } from '@/features/chat/remote';
import { createTerminalMode, type TerminalModeApi } from '@/features/workbench/terminal';
import { createPoking, type PokingApi } from './life/poke';
import { createAppViews, type AppViewsApi } from '@/features/mcp/apps';
import { createChatLog, type ChatLogApi } from '@/features/chat/log';
import { createDeskActivity, type DeskActivityApi } from './life/desk';
import { createFace, type FaceApi } from './life/face';
import { createChatMarkdown, type ChatMarkdownApi } from '@/features/chat/reply/local-files';
import { createQuickActions, type QuickActionsApi } from '@/features/workbench/quick/robot';
import { createChatSize, type ChatSizeApi } from '@/features/chat/size';
import { createTabs, type TabsApi } from '@/features/chat/tabs';
import { createHelpers, type HelpersApi } from '@/features/chat/agents';
import { createPlay, type PlayApi } from './life/play';
import { createComposer, type ComposerApi } from '@/features/chat/composer/composer';
import { createAsking, type AskingApi } from '@/features/chat/reply/ask';
import { type ChatEventsApi, createChatEvents } from '@/features/chat/events';
import { createCommentary, type CommentaryApi } from '@/features/chat/reply/commentary';
import { createLifeCycle, type LifeCycleApi } from './life/lifecycle';
import { lazy } from '@/lib/lazy';
import { createPastChats, type PastChatsApi } from '@/features/chat/past/resume';
import { createSidePanel, type SidePanelApi } from '@/features/chat/side/panel';
import { createShells, type ShellsApi } from '@/features/workbench/shell/drawer';
import { createWindowLayout } from './layout';

showView(markup, { title: 'C-Bot', bodyClass: 'asleep' });
tooltips($('#panel')); // (the chat's buttons say what they do)
tooltips($('#side-panel'));

(() => {
  // what the modules split off this window take from it (each create…(hub)): read when used,
  // as the closure would
  const hub = lazy(
    {
      activateTab: () => activateTab,
      active: () => active,
      current: () => current,
      character: () => character,
      addBot: () => addBot,
      addBrief: () => addBrief,
      addNote: () => addNote,
      addQaSummary: () => addQaSummary,
      addUser: () => addUser,
      animates: () => animates,
      answerFromComposer: () => answerFromComposer,
      antic: () => antic,
      anticUntil: () => idleAnticsPart.anticUntil,
      appCard: () => appCard,
      appResult: () => appResult,
      asideChip: () => asideChip,
      asideRow: () => asideRow,
      askedWord: () => askedWord,
      askUser: () => askUser,
      autosize: () => autosize,
      awayClick: () => awayClick,
      backFromView: () => backFromView,
      backToDesk: () => backToDesk,
      body: () => body,
      BONK_COOLDOWN_MS: () => BONK_COOLDOWN_MS,
      bonkAwake: () => bonkAwake,
      bonked: () => bonked,
      bonkRobot: () => bonkRobot,
      briefChips: () => briefChips,
      callChip: () => callChip,
      canAct: () => canAct,
      canActNotes: () => canActNotes,
      cancelEdit: () => cancelEdit,
      chatSizePart: () => chatSizePart,
      choose: () => choose,
      clearFinishedHelpers: () => clearFinishedHelpers,
      closeHelper: () => closeHelper,
      closeMenu: () => closeMenu,
      closeTab: () => closeTab,
      collapse: () => collapse,
      compactTab: () => compactTab,
      composerPart: () => composerPart,
      crashMonitor: () => crashMonitor,
      cue: () => cue,
      cycleMode: () => cycleMode,
      dedupePics: () => dedupePics,
      deniedNote: () => deniedNote,
      deskState: () => deskState,
      diffCard: () => diffCard,
      drinkMilkTea: () => drinkMilkTea,
      dropQueued: () => dropQueued,
      eat: () => eat,
      eatNoodles: () => eatNoodles,
      editBanner: () => editBanner,
      expireQuestion: () => expireQuestion,
      express: () => express,
      FILE_URL: () => FILE_URL,
      fill: () => fill,
      finishCompact: () => finishCompact,
      finishCurrent: () => finishCurrent,
      finishText: () => finishText,
      flash: () => flash,
      folderName: () => folderName,
      foldSteps: () => foldSteps,
      fromMeeting: () => fromMeeting,
      goneWalking: () => goneWalking,
      handDown: () => handDown,
      handUp: () => handUp,
      hasSteps: () => hasSteps,
      haveTreat: () => haveTreat,
      held: () => pokingPart.held,
      helpersOut: () => helpersOut,
      helperView: () => helperView,
      hidePalette: () => hidePalette,
      history: () => history,
      HURRY: () => HURRY,
      idleAnticsPart: () => idleAnticsPart,
      IMAGE_EXT: () => IMAGE_EXT,
      imageUrl: () => imageUrl,
      input: () => input,
      islandNews: () => islandNews,
      islandOn: () => islandOn,
      islandReport: () => islandReport,
      islandReportAgain: () => islandReportAgain,
      leaveDesk: () => leaveDesk,
      linkAnswer: () => linkAnswer,
      loadBrain: () => loadBrain,
      logs: () => logs,
      lookAt: () => lookAt,
      md: () => md,
      mentionsPart: () => mentionsPart,
      menuEl: () => menuEl,
      mirror: () => mirror,
      modeOf: () => modeOf,
      moveReply: () => moveReply,
      msgActions: () => msgActions,
      muted: () => muted,
      newTab: () => newTab,
      nightcap: () => nightcap,
      notesPart: () => notesPart,
      office: () => office,
      onAgent: () => onAgent,
      onEvent: () => onEvent,
      onLink: () => onLink,
      onNotes: () => onNotes,
      onRemote: () => onRemote,
      onSocial: () => onSocial,
      onTasks: () => onTasks,
      openChat: () => openChat,
      openEffortMenu: () => openEffortMenu,
      openFileView: () => openFileView,
      openHelper: () => openHelper,
      openHistory: () => openHistory,
      openInApp: () => openInApp,
      openMenu: () => openMenu,
      openModelMenu: () => openModelMenu,
      openNotesFromBoard: () => openNotesFromBoard,
      openTerminal: () => openTerminal,
      openToolView: () => openToolView,
      paletteEl: () => paletteEl,
      paletteKey: () => paletteKey,
      partFor: () => partFor,
      pasteClipboard: () => pasteClipboard,
      peek: () => peek,
      pendingQuestion: () => pendingQuestion,
      persona: () => persona,
      pickEffort: () => pickEffort,
      pickModel: () => pickModel,
      PLACEHOLDER: () => PLACEHOLDER,
      placePanel: () => placePanel,
      plain: () => plain,
      PLAY_MS: () => PLAY_MS,
      playWith: () => playWith,
      poke: () => poke,
      pokingPart: () => pokingPart,
      pop: () => pop,
      queueQuestion: () => queueQuestion,
      quip: () => quip,
      QUIZ_LINES: () => QUIZ_LINES,
      quizWord: () => vocabPart.quizWord,
      rawText: () => rawText,
      READ_AT_LEAST: () => READ_AT_LEAST,
      readDeskPlane: () => readDeskPlane,
      readVisitNote: () => readVisitNote,
      refreshCommands: () => refreshCommands,
      remoteNote: () => remoteNote,
      renderAttachments: () => renderAttachments,
      renderBrain: () => renderBrain,
      renderCurrent: () => renderCurrent,
      renderFace: () => renderFace,
      renderHelpers: () => renderHelpers,
      renderHistory: () => renderHistory,
      renderMeta: () => renderMeta,
      renderPose: () => renderPose,
      renderRemote: () => renderRemote,
      renderScreenAsks: () => renderScreenAsks,
      routineAnswer: () => routineAnswer,
      renderStepDetail: () => renderStepDetail,
      renderTabs: () => renderTabs,
      renderTodo: () => renderTodo,
      renderToolView: () => renderToolView,
      renderWorking: () => renderWorking,
      restingActivity: () => restingActivity,
      reviewPlan: () => reviewPlan,
      robot: () => robot,
      runLocalCommand: () => runLocalCommand,
      saveWordChip: () => saveWordChip,
      sayWord: () => sayWord,
      screenAsks: () => screenAsks,
      scrollDown: () => scrollDown,
      sentOf: () => sentOf,
      serverLabel: () => serverLabel,
      setActivity: () => setActivity,
      setBrain: () => setBrain,
      setBusy: () => setBusy,
      setSight: () => setSight,
      setStatus: () => setStatus,
      setStepOut: () => setStepOut,
      setTabStatus: () => setTabStatus,
      settleThinking: () => settleThinking,
      setVocabCount: () => setVocabCount,
      shell: () => shell,
      shortVi: () => shortVi,
      showAside: () => showAside,
      showContext: () => showContext,
      showPop: () => showPop,
      sides: () => sides,
      sightWord: () => sightWord,
      sleep: () => sleep,
      smack: () => smack,
      socialReport: () => socialReport,
      stagePart: () => stagePart,
      startCompact: () => startCompact,
      startReply: () => startReply,
      state: () => state,
      statusMeta: () => statusMeta,
      statusRow: () => statusRow,
      statusText: () => statusText,
      stopAntic: () => stopAntic,
      stopTab: () => stopTab,
      strikePose: () => strikePose,
      submit: () => submit,
      syncChrome: () => syncChrome,
      tabs: () => tabs,
      tabStrip: () => tabStrip,
      takeBack: () => takeBack,
      takeBriefs: () => takeBriefs,
      terminalState: () => terminalState,
      thinkRow: () => thinkRow,
      thumbImg: () => thumbImg,
      tickNoteChip: () => tickNoteChip,
      toggleRemote: () => toggleRemote,
      toggleShell: () => toggleShell,
      toMeeting: () => toMeeting,
      toolLook: () => toolLook,
      toolPics: () => toolPics,
      uid: () => uid,
      unpeek: () => unpeek,
      updateMentions: () => updateMentions,
      updatePalette: () => updatePalette,
      vocabPart: () => vocabPart,
      vocabReady: () => vocabReady,
      waitForBriefs: () => waitForBriefs,
      wake: () => wake,
      wanders: () => wanders,
      wordOf: () => wordOf,
      setStaged: () => setStaged,
      setClickThrough: () => setClickThrough,
    },
    {
      activeId: [() => activeId, (v: typeof activeId) => (activeId = v)],
      binEmptied: [
        () => quickActionsPart.binEmptied,
        (v: typeof quickActionsPart.binEmptied) => (quickActionsPart.binEmptied = v),
      ],
      lastMainActive: [() => lastMainActive, (v: typeof lastMainActive) => (lastMainActive = v)],
      paletteIndex: [() => slashPart.paletteIndex, (v: typeof slashPart.paletteIndex) => (slashPart.paletteIndex = v)],
      paletteItems: [() => slashPart.paletteItems, (v: typeof slashPart.paletteItems) => (slashPart.paletteItems = v)],
      screenShot: [
        () => attachmentsPart.screenShot,
        (v: typeof attachmentsPart.screenShot) => (attachmentsPart.screenShot = v),
      ],
    },
  );
  // (the view's elements, found with $: always in its markup, robot.html)
  const body = document.body;
  const robot = $('#robot');
  const deskState = officeData(robot); // (what the 3D office shows: office3d/protocol.ts)
  // (its canvas gone for good: main builds the window again, app/src/robots/revive.rs)
  const office = Office3D.mount($('#bot-host'), {
    stateEl: robot,
    moodEl: body,
    width: ROBOT_W,
    height: ROBOT_H,
    onLost: ipc.robotRevive,
  });
  // Check in with main every so often, and say when the page is hidden: one that goes quiet
  // is built again, one hidden while its window shows is nudged to draw (robots/revive.rs).
  const ALIVE_EVERY = 10000;
  const alive = () => ipc.robotAlive(document.visibilityState === 'hidden');
  alive();
  setInterval(alive, ALIVE_EVERY);
  document.addEventListener('visibilitychange', alive);
  const logs = $('#logs');
  const tabStrip = $('#tabs');
  const input = $<HTMLTextAreaElement>('#input');

  // Each tab is its own Claude Code conversation (they can run at the same
  // time). Per tab: its log, the reply being streamed, an open question, the
  // status line and a badge state.
  const tabs = new Map<string, ChatTab>(); // id -> tab
  let activeId: string | null = null;
  let lastMainActive: string | null = null;
  const active = () => (activeId ? tabs.get(activeId) : undefined); // (none yet: undefined)
  /** The tab you're in: there's one from the start (robot_init), so none is a bug. */
  function current() {
    const t = active();
    if (!t) throw new Error('No tab yet');
    return t;
  }
  const statusRow = $('#status');
  const statusText = $('#status-text');
  const statusMeta = $('#status-meta');
  const pop = $('#pop');

  const state: RobotState = {
    character: null,
    personalities: {},
    user: 'friend',
    awake: false,
    collapsed: false, // awake, but you tucked the chat away to watch it work
    news: '', // what happened while the chat was tucked away (shown on the status bubble)
    // the robot is "busy" while any of its tabs is working
    get busy() {
      return [...tabs.values()].some((t) => t.busy);
    },
    placement: 'none',
    robotX: 0,
    robotY: 0,
    pokes: [],
    face: null, // temporary expression override
    activity: 'off', // what's on the monitor
    pose: null, // temporary pose override
    lookOverride: null,
    lastCursor: { dx: 0, dy: 0 },
    lastActivity: Date.now(),
    attachments: [], // (the files fed to it: see feeding files)
    briefs: [], // (from other tabs: see @-mentions)
  };

  const persona = () =>
    state.personalities[state.character?.personality ?? ''] || Object.values(state.personalities)[0];
  const folderName = () => (state.character?.folder || '').split(/[\\/]/).filter(Boolean).pop() || 'this folder';
  /** The robot itself: robot_init brings it before anything is shown, so none is a bug. */
  function character() {
    if (!state.character) throw new Error('No character yet');
    return state.character;
  }
  const fill = (line: string) =>
    line.replaceAll('{name}', character().name).replaceAll('{folder}', folderName()).replaceAll('{user}', state.user);

  // markdown
  const { FILE_URL, IMAGE_EXT, dedupePics, imageUrl, md, openInApp }: ChatMarkdownApi = createChatMarkdown(hub); // (chat/reply/local-files.ts)

  // face
  const { express, flash, renderFace }: FaceApi = createFace(hub); // (life/face.ts)

  // desk activity
  const { helpersOut, look, lookAt, renderPose, restingActivity, setActivity, showPop, strikePose }: DeskActivityApi =
    createDeskActivity(hub);

  // briefs from its other tabs
  const { addBrief, briefChips, takeBriefs, waitForBriefs }: BriefsApi = createBriefs(hub); // (chat/brief.ts)

  // life cycle
  const {
    applyCharacter,
    collapse,
    islandNews,
    islandReport,
    islandReportAgain,
    openChat,
    peek,
    renderHistory,
    renderWorking,
    sleep,
    unpeek,
    wake,
  }: LifeCycleApi = createLifeCycle(hub); // (life/lifecycle.ts)

  // chat log
  const {
    addBot,
    addUser,
    callChip,
    diffCard,
    foldSteps,
    renderStepDetail,
    scrollDown,
    setStepOut,
    settleThinking,
    thinkRow,
    thumbImg,
    toolLook,
    toolPics,
  }: ChatLogApi = createChatLog(hub); // (chat/log.ts)

  // MCP tool views
  const { appCard, appResult, asideChip, serverLabel }: AppViewsApi = createAppViews(hub);

  // running commentary
  const { addNote, animates, deniedNote, plain, renderMeta, setStatus, setTabStatus, showAside }: CommentaryApi =
    createCommentary(hub); // (chat/reply/commentary.ts)

  // asking
  const {
    asideRow,
    dropQueued,
    finishCurrent,
    finishText,
    hasSteps,
    moveReply,
    partFor,
    queueQuestion,
    renderCurrent,
    setBusy,
    startReply,
    stopTab,
    submit,
    syncChrome,
    uid,
  }: AskingApi = createAsking(hub); // (chat/reply/ask.ts)
  const { onEvent }: ChatEventsApi = createChatEvents(hub); // (chat/events.ts: one function per kind)

  // poking & dragging
  const pokingPart: PokingApi = createPoking(hub); // (life/poke.ts)
  const { poke } = pokingPart;

  // composer
  const composerPart: ComposerApi = createComposer(hub); // (chat/composer/composer.ts)
  const { autosize, cancelEdit, editBanner, msgActions, rawText, sentOf, takeBack } = composerPart;

  // terminal mode
  const { openTerminal }: TerminalModeApi = createTerminalMode(hub); // (workbench/terminal.ts)

  // remote control
  const { mirror, onRemote, remoteNote, renderRemote, terminalState, toggleRemote }: RemoteControlApi =
    createRemoteControl(hub); // (chat/remote.ts)

  // questions from Claude
  const { askUser, handDown, handUp }: QuestionsApi = createQuestions(hub); // (chat/questions.ts)

  // plans from Claude
  const { addQaSummary, answerFromComposer, expireQuestion, pendingQuestion, reviewPlan }: PlansApi = createPlans(hub); // (chat/plan/card.ts)

  // feeding files
  const attachmentsPart: AttachmentsApi = createAttachments(hub); // (chat/composer/attachments.ts)
  const { PLACEHOLDER, eat, pasteClipboard, renderAttachments, screenAsks } = attachmentsPart;

  // the bonk
  const { BONK_COOLDOWN_MS, HURRY, bonkRobot, smack }: BonkApi = createBonk(hub);

  // playing with it
  const { PLAY_MS, bonkAwake, bonked, playWith }: PlayApi = createPlay(hub); // (life/play.ts)

  // to-do card
  const { onTasks, renderTodo }: TodoCardApi = createTodoCard(hub);

  // helper agents
  const {
    backFromView,
    clearFinishedHelpers,
    closeHelper,
    helperView,
    onAgent,
    openFileView,
    openHelper,
    openToolView,
    renderHelpers,
    renderToolView,
  }: HelpersApi = createHelpers(hub); // (chat/agents.ts)

  // brain: model, effort, memory
  const {
    closeMenu,
    compactTab,
    cycleMode,
    finishCompact,
    loadBrain,
    menuEl,
    modeOf,
    openEffortMenu,
    openMenu,
    openModelMenu,
    pickEffort,
    pickModel,
    renderBrain,
    setBrain,
    showContext,
    startCompact,
  }: BrainApi = createBrain(hub);

  // tabs
  const { activateTab, closeTab, newTab, renderTabs, syncTabs }: TabsApi = createTabs(hub); // (chat/tabs.ts)

  // slash commands
  const slashPart: SlashApi = createSlash(hub); // (chat/composer/slash.ts)
  const { hidePalette, paletteEl, runLocalCommand, updatePalette } = slashPart;

  // @-mentions
  const mentionsPart: MentionsApi = createMentions(hub); // (chat/composer/mentions.ts)
  const { choose, paletteKey, refreshCommands, updateMentions } = mentionsPart;
  // ------------------------------------------------------------ a shell in my folder

  const { shell, toggleShell }: ShellsApi = createShells(hub); // (workbench/shell/drawer.ts)
  // ------------------------------------------------------------ side questions (chat/side/threads.ts)

  const { sides }: SidePanelApi = createSidePanel(hub); // (chat/side/panel.ts)
  // ------------------------------------------------------------ past conversations

  const { history, openHistory }: PastChatsApi = createPastChats(hub); // (chat/past/resume.ts)

  // ------------------------------------------------------------ ambient life

  function blinkLoop() {
    if (state.awake || state.busy) flash('blink', 170);
    setTimeout(blinkLoop, rand(2200, 6000));
  }

  // idle antics
  const idleAnticsPart: IdleAnticsApi = createIdleAntics(hub); // (life/antics.ts)
  const {
    antic,
    antics,
    awayClick,
    backToDesk,
    busted,
    crashMonitor,
    cue,
    dozeLoop,
    fromMeeting,
    goneWalking,
    leaveDesk,
    nightcap,
    quip,
    stopAntic,
    toMeeting,
    wanders,
  } = idleAnticsPart;

  // chat size and click-through
  const chatSizePart: ChatSizeApi = createChatSize(hub); // (chat/size.ts)
  const { placePanel, setClickThrough } = chatSizePart;

  // the stage (app/src/robots/stage/mod.rs)
  const stagePart: StageApi = createStage(hub); // (robots/stage/tile.ts)
  const { setStaged } = stagePart;
  // ------------------------------------------------------------ main-process events

  createWindowLayout(hub); // (layout.ts)

  // cursor position arrives relative to the robot box; aim from the robot's head
  ipc.on('robot:cursor', (c) => {
    if (state.peek) return;
    const head = office.headPosition();
    state.lastCursor = { dx: c.x - head.x, dy: c.y - head.y };
    look();
    propCursor(c);
    if ((state.slacking ?? 0) > Date.now() && Math.hypot(state.lastCursor.dx, state.lastCursor.dy) < 200) busted();
  });

  ipc.on('robot:event', onEvent);

  ipc.on('robot:character', (c) => {
    applyCharacter(c);
    syncTabs(c);
  });

  // the Sounds setting: essential / all / off (off keeps the word-reading voice quiet too)
  let muted = false;
  function setSounds(s: Settings) {
    muted = s.sounds === 'off';
    Sfx.setLevel(s.sounds);
  }
  ipc.on('robot:settings', (s) => {
    setSounds(s);
    islandButton(s);
  });
  // the 🏝️ button: to sleep instead while the island's turned off
  let islandOn = true;
  function islandButton(s: Settings) {
    islandOn = s.island !== false;
    const b = $('#btn-island');
    b.title = islandOn ? 'Send to island' : 'Sleep (Esc)';
    b.dataset.tip = b.title;
    b.innerHTML = Icon(islandOn ? 'island' : 'moon');
  }
  // you're presenting or in a full-screen app: only a question for you still dings (main)
  ipc.on('robot:hush', (on) => Sfx.setHush(on));

  // English words (main/vocab.js)
  const vocabPart: VocabApi = createVocab(hub); // (vocab/robot.ts)
  const {
    QUIZ_LINES,
    READ_AT_LEAST,
    askedWord,
    canAct,
    sayWord,
    setSight,
    setVocabCount,
    shortVi,
    sightWord,
    vocabReady,
    wordOf,
  } = vocabPart;

  // notes
  const notesPart: NotesApi = createNotes(hub); // (notes/robot.ts)
  const { canActNotes, onNotes, openNotesFromBoard, setBoard } = notesPart;

  // ask about the screen
  const { renderScreenAsks }: ScreenAskApi = createScreenAsk(hub); // (workbench/snip/robot.ts)

  // the other robots
  const { drinkMilkTea, eatNoodles, haveTreat, onSocial, readDeskPlane, readVisitNote, socialReport }: OtherRobotsApi =
    createOtherRobots(hub); // (robots/reactions.ts)

  // messages from other robots
  const { linkAnswer, onLink }: RobotMessagesApi = createRobotMessages(hub); // (robots/link/asks.ts)

  // handed-off tasks
  createHandedOffTasks(hub);

  // routines
  const { routineAnswer }: RoutinesApi = createRoutines(hub); // (routines/robot.ts)

  // quick actions
  const quickActionsPart: QuickActionsApi = createQuickActions(hub); // (workbench/quick/robot.ts)
  const { propCursor, saveWordChip, tickNoteChip } = quickActionsPart;

  // ------------------------------------------------------------ boot

  (async () => {
    const init = await ipc.robotInit();
    if (!init.character) return;
    state.personalities = init.personalities;
    state.user = init.user;
    setSounds(init.settings);
    islandButton(init.settings);
    Sfx.setHush(!!init.hush);
    applyCharacter(init.character);
    setVocabCount(init.vocabCount);
    setSight(init.vocabSight || []);
    setBoard(init.notesBoard);
    syncTabs(init.character);
    if (init.character.peek) {
      // (away on the island when it was last closed: main keeps it veiled)
      state.peek = true;
      deskState.peek = '1';
    }
    ipc.robotExpand(false); // every (re)load starts asleep; keep the window in sync
    const terminalTab = init.character.terminalTab ? tabs.get(init.character.terminalTab) : undefined;
    if (init.character.terminalOpen && terminalTab) terminalState('opened', terminalTab, { quiet: true });
    setActivity('off');
    renderFace();
    refreshCommands();
    blinkLoop();
    setTimeout(antics, 8000);
    setTimeout(dozeLoop, rand(20000, 40000));
  })();
})();
