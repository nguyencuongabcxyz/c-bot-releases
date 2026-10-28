// 🔨 A squeaky-hammer bonk. Asleep: it jolts awake. Working: it drops what it's doing and starts the
// same question over, told to hurry. Idle: it just yelps.
// (robot.ts calls createBonk with its hub.)
import type { PlayApi } from './play';
import type { FaceApi } from './face';
import type { VocabApi } from '@/features/vocab/robot';
import { Sfx } from '../sound';
import * as ipc from '@/ipc';

/** What it uses of the robot window (robot.ts's hub). */
export type BonkNeeds = {
  readonly bonked: PlayApi['bonked'];
  readonly express: FaceApi['express'];
  readonly flash: FaceApi['flash'];
  readonly vocabPart: VocabApi;
};

export function createBonk(r: BonkNeeds) {
  // 🔨 A squeaky-hammer bonk. Asleep: it jolts awake. Working: it drops what it's doing and starts the
  // same question over, told to hurry. Idle: it just yelps.
  const HURRY = '\n\n⚡ Hurry up! Be quick: keep it short, skip the extras, and go straight to the result.';
  const BONK_COOLDOWN_MS = 3000;

  // The bonk itself: a squeaky toy hammer swings in and bonks the robot on the
  // head (drawn in 3D, see office3d/hammer.js). onHit runs the moment it lands.
  const BONK_HIT_MS = 420; // BONK.hit in office3d/index.js
  function smack(onHit: () => void) {
    r.flash('bonk', 1100);
    setTimeout(() => Sfx.key.swish(), BONK_HIT_MS - 110); // the swing
    setTimeout(() => {
      Sfx.key.squeak(); // the squeaky toy lands
      r.flash('shake', 400);
      onHit();
    }, BONK_HIT_MS);
  }

  function bonkRobot() {
    if (r.vocabPart.quizWord) {
      // a bonk mid-quiz: not now, thanks
      return smack(() => {
        ipc.robotVocabQuiz('later');
        r.express('dizzy', 'o', 1200);
      });
    }
    smack(r.bonked);
  }
  return { BONK_COOLDOWN_MS, HURRY, bonkRobot, smack };
}
export type BonkApi = ReturnType<typeof createBonk>;
