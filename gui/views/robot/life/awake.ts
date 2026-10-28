// What the robot does awake and idle, once antics.ts has picked it: the antic (the 3D office
// plays it) and the sounds, faces and words timed to it. One entry per antic; one that's only
// an antic with no extras isn't here (antics.ts plays it as it is).
import { pick, rand } from '@/lib/random';
import { Sfx } from '../sound';
import type { IdleAnticsNeeds } from './antics';
import type { Quips } from '@/types/model';

/** What the plays use: antics.ts's own helpers, and the robot window. */
export type AwakeKit = {
  rw: IdleAnticsNeeds;
  antic: (name: string, text?: string) => void;
  cue: (sec: number, fn: () => void) => void;
  quip: <K extends keyof Quips>(k: K) => NonNullable<ReturnType<IdleAnticsNeeds['persona']>['quips']>[K] | undefined;
  slack: () => void;
  leaveDesk: () => void;
  /** the robot's own little antics (its body's) */
  critters: () => string[];
  /** no other antic until then (a dance or a high-five isn't an antic of its own) */
  holdUntil: (t: number) => void;
};

/** The same play under two names (the toss that misses and the one that scores…). */
const both = (a: string, b: string, play: (name: string) => void) => ({ [a]: play, [b]: play });

export function awakePlays(k: AwakeKit): Partial<Record<string, (name: string) => void>> {
  const { rw, antic, cue, quip, slack, leaveDesk } = k;
  // a dance or a high-five: it plays it with you, and no antic meanwhile
  const party = (what: 'dance' | 'highfive') => {
    rw.playWith(what, { byUser: false });
    k.holdUntil(Date.now() + rw.PLAY_MS[what]);
  };
  return {
    dance: () => party('dance'),
    highfive: () => party('highfive'),
    boardglance: (name) => {
      antic(name);
      cue(1.2, () => Sfx.tool());
      cue(1.6, () => {
        rw.express('open', 'flat', 900);
        if (Math.random() < 0.5) rw.showPop(quip('notesNudge') || 'Psst… your notes!', 1600);
      });
    },
    notestress: () => {
      // a full board weighs on it
      antic('slump');
      rw.express('dizzy', 'flat', 2200);
      cue(0.9, () => rw.showPop(quip('notesStress') || 'So… many… notes…', 1800));
    },
    look: () => {
      rw.lookAt(rand(-300, 300), rand(-100, 100), 1100);
      setTimeout(() => rw.lookAt(rand(-300, 300), rand(-100, 100), 900), 1100);
    },
    wave: () => {
      rw.strikePose('wave', 1500);
    },
    hop: () => {
      rw.flash('hop', 600);
    },
    spin: () => {
      // spin around in the office chair
      rw.flash('spin', 950);
      Sfx.whee();
    },
    stretch: () => {
      // big stretch and a yawn
      rw.strikePose('cheer', 1300);
      rw.express('closed', 'o', 1300);
    },
    smile: () => {
      rw.express('happy', 'smile', 1200);
    },
    talk: () => {
      // thinking out loud
      rw.showPop(rw.fill(pick(rw.persona().bored || ['…'])), 2600);
      rw.express('open', 'talk', 1200);
    },
    slack: () => {
      slack();
    },
    attention: () => {
      rw.strikePose('wave', 2000);
      rw.express('happy', 'wide', 2000);
      rw.showPop(quip('attention') || 'Hey!', 2200);
    },
    critter: () => {
      const c = pick(k.critters());
      antic(c);
      if (c === 'robot-antenna') cue(0.6, () => Sfx.boing());
      if (c === 'robot-defrag') rw.express('dizzy', 'flat', 1800);
    },
    pushup: (name) => {
      // timings match office3d/antics/pushup.js: hop down 0.45, reps from 1.3 every 1.1 s, hop back 8.9
      antic(name);
      cue(0.45, () => Sfx.boing());
      [1.3, 2.4, 3.5, 4.6, 5.7].forEach((at, i) => {
        cue(at + (i === 4 ? 0.8 : 0.45), () => Sfx.grunt());
      });
      cue(5.7, () => rw.express('flat', 'flat', 1600)); // the last one's a struggle
      cue(8.9, () => Sfx.boing());
      cue(9.1, () => {
        rw.express('happy', 'wide', 1400);
        rw.showPop(quip('flex') || 'Feel the burn! 💪', 1600);
      });
    },
    phone: (name) => {
      // doom scrolling; timings match office3d/antics/phone.js
      antic(name);
      cue(0.4, () => Sfx.pop());
      for (let at = 0.9; at < 6; at += 0.8) cue(at, () => Sfx.tool()); // thumb flicks
      cue(3.4, () => {
        Sfx.giggle();
        rw.express('happy', 'wide', 1300);
      });
      cue(6.3, () => Sfx.pop());
    },
    dumbbell: (name) => {
      // three curls, the last a struggle, then a flex; timings match the antic in office3d/antics/awake.js
      antic(name);
      cue(0.15, () => Sfx.pop());
      cue(1.0, () => rw.showPop('1!', 600));
      cue(1.8, () => rw.showPop('2!', 600));
      cue(2.4, () => {
        rw.express('closed', 'flat', 600);
        Sfx.grunt();
      });
      cue(2.9, () => {
        rw.express('happy', 'wide', 700);
        rw.showPop('…3!!', 700);
      });
      cue(4.0, () => {
        Sfx.done();
        rw.express('happy', 'smile', 1300);
        rw.showPop(quip('flex') || 'Gains!', 1500);
      });
    },
    feed: (name) => {
      // scrolling a feed on the monitor; timings match office3d/feeds.js
      antic(name, pick(['facebook', 'tiktok', 'youtube']));
      cue(0.6, () => rw.express('open', 'flat', 4000)); // the glazed scrolling stare
      for (const at of [1.0, 2.0, 3.0, 4.0, 7.0, 8.0]) cue(at, () => Sfx.wheel());
      cue(4.8, () => {
        Sfx.giggle();
        rw.express('happy', 'wide', 1400);
      });
      cue(6.2, () => {
        Sfx.pop();
        rw.express('happy', 'smile', 1200);
      });
      cue(7.4, () => rw.express('open', 'flat', 1800));
    },
    milktea: () => {
      rw.drinkMilkTea();
    },
    standdesk: (name) => {
      // timings match the antic in office3d/antics/awake.js
      antic(name);
      cue(1.5, () => Sfx.beep());
      cue(1.6, () => Sfx.motor(true));
      cue(4.6, () => rw.express('flat', 'o', 900)); // hm, too low now
      cue(5.6, () => Sfx.hiss());
      cue(8.6, () => rw.express('happy', 'smile', 1800));
      cue(16.3, () => Sfx.beep());
      cue(16.4, () => Sfx.motor(false));
    },
    'sip-empty': (name) => {
      antic(name);
      cue(1.6, () => {
        rw.express('flat', 'flat', 1300);
        rw.showPop(quip('empty') || '…', 1600);
      });
    },
    tip: (name) => {
      antic(name);
      cue(1.5, () => {
        Sfx.oops();
        rw.express('open', 'wide', 600);
      });
      cue(2.2, () => rw.showPop(quip('tip') || '…', 1500));
    },
    ...both('toss', 'toss-hit', (name: string) => {
      antic(name);
      cue(1.9, () => {
        if (name === 'toss-hit') {
          Sfx.done();
          rw.express('happy', 'wide', 1000);
          rw.showPop(quip('score') || '!', 1400);
        } else {
          rw.express('flat', 'flat', 1000);
          rw.showPop(quip('miss') || '…', 1400);
        }
      });
    }),
    hum: (name) => {
      antic(name);
      rw.express('happy', 'o', 4300);
      Sfx.hum();
      cue(2.2, () => Sfx.hum());
    },
    sneeze: (name) => {
      antic(name);
      cue(0.2, () => rw.express('closed', 'o', 700));
      cue(0.9, () => {
        Sfx.sneeze();
        rw.express('closed', 'wide', 500);
        rw.showPop(quip('sneeze') || 'Achoo!', 1100);
      });
    },
    lamp: (name) => {
      antic(name);
      for (const at of [1.0, 1.3, 1.5, 1.9]) cue(at, () => Sfx.tool());
    },
    slump: (name) => {
      antic(name);
      rw.express('flat', 'flat', 2600);
    },
    duck: (name) => {
      // rubber duck debugging: explains, the duck squeaks, OH!
      antic(name);
      cue(0.3, () => Sfx.pop());
      cue(0.8, () => {
        rw.express('open', 'talk', 2600);
        rw.showPop(quip('duck') || '…', 2400);
      });
      cue(3.8, () => Sfx.squeak());
      cue(4.3, () => {
        Sfx.done();
        rw.express('happy', 'wide', 1200);
        rw.showPop(quip('oh') || 'OH!', 1500);
      });
    },
    reboot: (name) => {
      // the screen freezes: glare, tap tap, power off and on again
      antic(name);
      cue(0.3, () => rw.express('flat', 'flat', 1600));
      for (const at of [1.4, 1.7, 3.0]) cue(at, () => Sfx.tool());
      cue(3.6, () => Sfx.wake());
      cue(5.8, () => {
        rw.express('happy', 'smile', 1100);
        rw.showPop(quip('reboot') || 'Fixed!', 1300);
      });
    },
    stackoverflow: (name) => {
      antic(name);
      for (const at of [1.8, 2.9]) cue(at, () => Sfx.thunk());
      cue(3.6, () => rw.express('open', 'flat', 1200));
      cue(3.8, () => rw.showPop(quip('so') || '…', 1300));
    },
    cable: (name) => {
      antic(name);
      for (const at of [1.2, 1.6]) cue(at, () => Sfx.tool());
      cue(2.2, () => {
        Sfx.thunk();
        rw.express('open', 'wide', 1500);
      });
      cue(2.9, () => rw.showPop(quip('cable') || 'Oops.', 1500));
    },
    ...both('crumbs', 'crumbs-cookie', (name: string) => {
      antic(name);
      cue(1.2, () => Sfx.rattle());
      if (name === 'crumbs-cookie') {
        cue(2.7, () => {
          Sfx.ooh();
          rw.express('happy', 'wide', 1300);
          rw.showPop(quip('cookie') || '!', 1500);
        });
      }
    }),
    merge: (name) => {
      antic(name);
      cue(1.2, () => {
        rw.express('dizzy', 'flat', 1800);
        rw.showPop(quip('merge') || '?!', 1700);
      });
      cue(3.2, () => rw.express('closed', 'smile', 2400));
      cue(3.4, () => rw.showPop((quip('breathe') || [])[0] || '…', 1100));
      cue(4.6, () => rw.showPop((quip('breathe') || [])[1] || '…', 1100));
    },
    standup: (name) => {
      // the daily stand-up, standing on its chair
      antic(name);
      const lines = quip('standup') || ['Yesterday: stuff.', 'Today: more stuff.', 'Blockers: you.'];
      lines.forEach((line, i) => {
        cue(1.0 + i * 1.8, () => {
          rw.express('open', 'talk', 1500);
          rw.showPop(line, 1700);
        });
      });
    },
    jira: (name) => {
      // (with notes of your own, it juggles those)
      antic(
        name,
        rw.notesPart.board.items
          .slice(0, 3)
          .map((n) => n.text)
          .join('|'),
      );
      cue(4.0, () => {
        Sfx.oops();
        rw.express('closed', 'flat', 1000);
      });
      cue(5.4, () => rw.showPop(quip('jira') || '…', 1400));
    },
    works: (name) => {
      antic(name);
      cue(0.3, () => {
        rw.express('happy', 'smile', 1500);
        rw.showPop(quip('works') || 'Works on my machine!', 1700);
      });
      cue(1.8, () => Sfx.thunk());
      cue(2.5, () => rw.express('happy', 'smile', 1800));
    },
    jitter: (name) => {
      // three coffees in a row, then warp-speed typing
      antic(name);
      for (const at of [0.8, 1.5, 2.2]) cue(at, () => Sfx.slurp());
      cue(2.4, () => rw.express('open', 'wide', 3800));
      cue(2.6, () => rw.showPop(quip('jitter') || '!!!', 1500));
    },
    friday: (name) => {
      antic(name);
      rw.express('flat', 'flat', 4000);
      cue(0.5, () => rw.showPop(quip('friday') || 'No deploys on Friday!', 2600));
    },
    monday: (name) => {
      antic(name);
      rw.express('flat', 'flat', 5600);
      cue(1.0, () => rw.showPop(quip('monday') || '…coffee.', 2000));
    },
    noodles: () => {
      rw.eatNoodles();
    },
    payday: (name) => {
      antic(name);
      cue(0.3, () => {
        Sfx.kaching();
        rw.express('happy', 'wide', 2400);
      });
      cue(4.2, () => {
        rw.express('flat', 'flat', 1600);
        rw.showPop(quip('payday') || '…', 1600);
      });
    },
    wander: () => {
      leaveDesk();
    },
    'dvd-lucky': (name) => {
      antic(name);
      cue(6.0, () => {
        Sfx.done();
        rw.express('happy', 'wide', 1500);
        rw.showPop(quip('corner') || '!', 1800);
      });
    },
  };
}
