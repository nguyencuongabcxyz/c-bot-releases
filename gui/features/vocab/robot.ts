// You select a word anywhere and press the hotkey: the robot nearest the mouse
// catches it, leafs through its dictionary while Claude looks it up (the word
// card beside it shows the word meanwhile), then says the word, holds up a
// flash card of it and pops it into the word box on its desk.
// (robot.ts calls createVocab with its hub.)
import type { DeskActivityApi } from '@/views/robot/life/desk';
import type { FaceApi } from '@/views/robot/life/face';
import type { LifeCycleApi } from '@/views/robot/life/lifecycle';
import type { RobotState } from '@/views/robot/types';
import { writeJson, type OfficeData } from '@/office3d/protocol';
import type { SightWord, VocabWord } from '@/types/model';

/** What it uses of the robot window (robot.ts's hub). */
export type VocabNeeds = {
  readonly deskState: OfficeData;
  readonly express: FaceApi['express'];
  readonly helpersOut: DeskActivityApi['helpersOut'];
  readonly muted: boolean;
  readonly held: boolean;
  readonly state: RobotState;
  readonly wake: LifeCycleApi['wake'];
};

export function createVocab(rw: VocabNeeds) {
  // You select a word anywhere and press the hotkey: the robot nearest the mouse
  // catches it, leafs through its dictionary while Claude looks it up (the word
  // card beside it shows the word meanwhile), then says the word, holds up a
  // flash card of it and pops it into the word box on its desk.
  const wordOf = (w?: VocabWord | null) => w?.word || w?.text || '';
  // the words to keep in sight (main: sightWords): [{ id, word, vi, phrase, box }], still-learning first
  let sight: SightWord[] = [];
  let quizWord: VocabWord | null = null; // the word on the quiz card it's holding up
  const shortVi = (vi = '') => vi.split(/[;,(]/)[0].trim();
  // the first three on sticky notes on its monitor (office3d: data-vocab-stickies)
  function setSight(words: SightWord[] = []) {
    sight = words;
    writeJson(
      rw.deskState,
      'vocabStickies',
      words.slice(0, 3).map((x) => ({ id: x.id, text: x.word, sub: shortVi(x.vi) })),
    );
  }
  // one of them, the ones you're still learning more often
  function sightWord() {
    if (!sight.length) return null;
    const weights = sight.map((x) => 1 / (1 + (x.box || 0)));
    let r = Math.random() * weights.reduce((a, b) => a + b, 0);
    for (const [i, wt] of weights.entries()) {
      r -= wt;
      if (r < 0) return sight[i];
    }
    return sight[0];
  }
  const QUIZ_LINES = [
    'Pop quiz! 🃏 Remember “{w}”?',
    "Quick one: what's “{w}”? 🤔",
    'Do you still know “{w}”?',
    'Word time! “{w}” means…?',
  ];
  let countLater: number | undefined;
  let leafingSince = 0; // when it opened the dictionary: it reads for a moment even when the answer is quick
  const READ_AT_LEAST = 2500;
  const setVocabCount = (n?: number) => (rw.deskState.vocabCount = String(n || 0));
  // free to act it out (not in the middle of a job)
  const canAct = () => !rw.state.busy && !rw.helpersOut() && !rw.state.mirroring && !rw.held;
  // awake enough to show it: a sleeping robot wakes up, its chat staying tucked away
  function vocabReady() {
    if (rw.state.away) return false;
    if (!rw.state.awake) rw.wake({ sayHi: false, tucked: true });
    rw.state.lastActivity = Date.now();
    return true;
  }

  // read a word out with an English voice, the mouth going along
  function sayWord(text: string) {
    if (!text || !window.speechSynthesis || rw.muted) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const voices = speechSynthesis.getVoices();
    u.voice =
      voices.find((v) => v.lang === 'en-US' && /natural|aria|jenny|guy/i.test(v.name)) ||
      voices.find((v) => v.lang === 'en-US') ||
      voices.find((v) => v.lang.startsWith('en')) ||
      null;
    u.lang = 'en-US';
    u.rate = 0.9;
    u.onstart = () => rw.express('happy', 'talk', 900);
    speechSynthesis.speak(u);
  }

  // "what does meticulous mean?", "define X", "X nghĩa là gì": the word asked about ('' if none)
  const ASKED = [
    /\bwhat(?:'s| does| do| is)\s+(?:the\s+(?:word|phrase|term)\s+)?["“'‘]?([a-z][a-z' -]{1,40}?)["”'’]?\s+mean\b/i,
    /\b(?:meaning of|define|definition of)\s+(?:the\s+(?:word|phrase|term)\s+)?["“'‘]?([a-z][a-z' -]{1,40}?)["”'’]?\s*(?:[?.!]|$)/i,
    /(?:^|\s)["“'‘]?([a-z][a-z' -]{1,40}?)["”'’]?\s+(?:có\s+)?nghĩa\s+là\s+gì/i,
  ];
  // ("what does this error mean?" is about something else)
  const NOT_A_WORD = /^(this|that|these|those|it|the|a|an|my|your|our|his|her|their)\b/i;
  function askedWord(text = '') {
    for (const re of ASKED) {
      const w = re.exec(text)?.[1]?.trim();
      if (w && w.split(/\s+/).length <= 4 && !NOT_A_WORD.test(w)) return w;
    }
    return '';
  }
  return {
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
    get countLater() {
      return countLater;
    },
    set countLater(v) {
      countLater = v;
    },
    get leafingSince() {
      return leafingSince;
    },
    set leafingSince(v) {
      leafingSince = v;
    },
    get quizWord() {
      return quizWord;
    },
    set quizWord(v) {
      quizWord = v;
    },
    get sight() {
      return sight;
    },
    set sight(v) {
      sight = v;
    },
  };
}
export type VocabApi = ReturnType<typeof createVocab>;
