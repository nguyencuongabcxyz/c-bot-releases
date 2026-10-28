// Little drawings of the builder's parts and what it wears, one per tile (currentColor: the accent).
import type { Parts } from './kit';

const P = (body: string) =>
  `<svg viewBox="0 0 52 40" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const SOFT = 'fill="currentColor" fill-opacity="0.18"';
export const KIT_ICONS: Record<string, Parts> = {
  head: {
    box: P(
      `<rect x="10" y="7" width="32" height="26" rx="8" ${SOFT}/><rect x="15" y="12" width="22" height="13" rx="4"/>`,
    ),
    ball: P(`<circle cx="26" cy="20" r="14" ${SOFT}/><path d="M17 20 a9 6 0 0 1 18 0"/>`),
    dome: P(`<path d="M11 33 V20 a15 15 0 0 1 30 0 V33 Z" ${SOFT}/><rect x="15" y="20" width="22" height="9" rx="3"/>`),
    capsule: P(
      `<rect x="16" y="4" width="20" height="32" rx="10" ${SOFT}/><rect x="19" y="15" width="14" height="10" rx="3"/>`,
    ),
    tv: P(
      `<rect x="8" y="8" width="36" height="25" rx="3" ${SOFT}/><rect x="12" y="12" width="22" height="17" rx="2"/><circle cx="39" cy="15" r="1.5"/><circle cx="39" cy="22" r="1.5"/><path d="M20 8 L16 3 M28 8 L32 3"/>`,
    ),
    bucket: P(`<path d="M10 8 H42 L38 34 H14 Z" ${SOFT}/><rect x="16" y="15" width="20" height="11" rx="3"/>`),
  },
  face: {
    dots: P(
      `<rect x="7" y="6" width="38" height="28" rx="8"/><ellipse cx="19" cy="17" rx="3" ry="4" fill="currentColor"/><ellipse cx="33" cy="17" rx="3" ry="4" fill="currentColor"/><path d="M21 25 q5 4 10 0"/>`,
    ),
    cute: P(
      `<rect x="7" y="6" width="38" height="28" rx="10"/><circle cx="18" cy="17" r="5" fill="currentColor"/><circle cx="34" cy="17" r="5" fill="currentColor"/><path d="M23 26 q3 2.5 6 0"/>`,
    ),
    visor: P(
      `<rect x="7" y="6" width="38" height="28" rx="6"/><rect x="11" y="13" width="30" height="9" rx="4.5" ${SOFT}/><path d="M16 17.5 h5 M31 17.5 h5"/><path d="M23 28 h6"/>`,
    ),
    cyclops: P(
      `<rect x="7" y="6" width="38" height="28" rx="8"/><circle cx="26" cy="17" r="6"/><circle cx="26" cy="17" r="2.2" fill="currentColor"/><path d="M22 28 q4 3 8 0"/>`,
    ),
    pixel: P(
      `<rect x="7" y="6" width="38" height="28" rx="3"/><rect x="15" y="12" width="5" height="7" fill="currentColor" stroke="none"/><rect x="32" y="12" width="5" height="7" fill="currentColor" stroke="none"/><path d="M19 25 h3 v2 h8 v-2 h3" stroke-linecap="square"/>`,
    ),
  },
  top: {
    antenna: P(`<path d="M26 34 V14"/><circle cx="26" cy="10" r="4" fill="currentColor"/><path d="M14 34 h24"/>`),
    twin: P(
      `<path d="M22 34 L16 14 M30 34 L36 14"/><circle cx="15" cy="11" r="3" fill="currentColor"/><circle cx="37" cy="11" r="3" fill="currentColor"/><path d="M12 34 h28"/>`,
    ),
    ears: P(`<path d="M12 34 L16 10 L25 30 M40 34 L36 10 L27 30" ${SOFT}/><path d="M12 34 h28"/>`),
    propeller: P(
      `<path d="M26 34 V18 M12 15 h28"/><circle cx="26" cy="15" r="2.5" fill="currentColor"/><path d="M12 34 h28"/>`,
    ),
    dish: P(
      `<path d="M26 34 V22"/><path d="M14 12 a12 9 0 0 0 24 6 Z" ${SOFT}/><circle cx="31" cy="12" r="2" fill="currentColor"/><path d="M12 34 h28"/>`,
    ),
    bulb: P(
      `<circle cx="26" cy="15" r="9" ${SOFT}/><path d="M22 25 h8 v5 h-8 z"/><path d="M23 15 l3 3 l3 -3"/><path d="M12 34 h28"/>`,
    ),
    none: P(`<path d="M12 34 h28"/><path d="M20 16 l12 12 M32 16 l-12 12" stroke-opacity="0.5"/>`),
  },
  body: {
    box: P(
      `<rect x="13" y="6" width="26" height="28" rx="7" ${SOFT}/><circle cx="26" cy="16" r="2.5" fill="currentColor"/>`,
    ),
    barrel: P(
      `<path d="M14 8 h24 v24 h-24 z" ${SOFT}/><path d="M13 8 h26 M13 32 h26"/><circle cx="26" cy="17" r="2.5" fill="currentColor"/>`,
    ),
    egg: P(`<ellipse cx="26" cy="21" rx="12" ry="14" ${SOFT}/><circle cx="26" cy="17" r="2.5" fill="currentColor"/>`),
    slim: P(
      `<rect x="19" y="5" width="14" height="30" rx="7" ${SOFT}/><circle cx="26" cy="16" r="2.2" fill="currentColor"/>`,
    ),
    chunky: P(
      `<rect x="11" y="9" width="30" height="25" rx="5" ${SOFT}/><circle cx="10" cy="11" r="4"/><circle cx="42" cy="11" r="4"/><circle cx="26" cy="19" r="2.5" fill="currentColor"/>`,
    ),
  },
  arms: {
    classic: P(
      `<circle cx="12" cy="9" r="3"/><path d="M12 12 L14 22 L20 30"/><circle cx="22" cy="32" r="3.5" fill="currentColor"/><circle cx="40" cy="9" r="3"/><path d="M40 12 L38 22 L32 30"/><circle cx="30" cy="32" r="3.5" fill="currentColor"/>`,
    ),
    noodle: P(
      `<path d="M12 8 q-4 12 6 14 q8 2 4 10"/><path d="M40 8 q4 12 -6 14 q-8 2 -4 10"/><circle cx="22" cy="33" r="2" fill="currentColor"/><circle cx="30" cy="33" r="2" fill="currentColor"/>`,
    ),
    mitten: P(
      `<path d="M12 8 L15 22"/><ellipse cx="17" cy="29" rx="6" ry="5" ${SOFT}/><path d="M40 8 L37 22"/><ellipse cx="35" cy="29" rx="6" ry="5" ${SOFT}/>`,
    ),
    claw: P(
      `<path d="M12 8 L15 22"/><path d="M15 22 l-4 9 M15 22 l4 9"/><path d="M40 8 L37 22"/><path d="M37 22 l-4 9 M37 22 l4 9"/>`,
    ),
  },
  base: {
    legs: P(`<path d="M20 6 V22 L18 32 M32 6 V22 L34 32"/><path d="M13 33 h9 M30 33 h9"/>`),
    wheel: P(
      `<path d="M22 6 L24 22 M30 6 L28 22"/><circle cx="26" cy="28" r="7" ${SOFT}/><circle cx="26" cy="28" r="2" fill="currentColor"/>`,
    ),
    treads: P(
      `<path d="M18 6 V20 M34 6 V20"/><rect x="10" y="22" width="14" height="11" rx="5" ${SOFT}/><rect x="28" y="22" width="14" height="11" rx="5" ${SOFT}/>`,
    ),
    hover: P(`<path d="M16 8 h20 l-4 12 h-12 z" ${SOFT}/><path d="M22 23 l4 11 l4 -11" stroke-opacity="0.7"/>`),
    spring: P(`<path d="M26 5 V9 l-6 3 l12 4 l-12 4 l12 4 l-6 3 V31"/><path d="M17 34 h18"/>`),
  },
  finish: {
    matte: P(`<circle cx="26" cy="20" r="13" fill="currentColor" fill-opacity="0.45" stroke="none"/>`),
    glossy: P(
      `<circle cx="26" cy="20" r="13" fill="currentColor" fill-opacity="0.45" stroke="none"/><path d="M19 14 a8 8 0 0 1 7 -4" stroke="#fff" stroke-width="3"/>`,
    ),
    metal: P(
      `<circle cx="26" cy="20" r="13" fill="currentColor" fill-opacity="0.3" stroke="none"/><path d="M15 26 L33 10 M19 30 L37 14" stroke="#fff" stroke-opacity="0.8"/>`,
    ),
    wood: P(
      `<circle cx="26" cy="20" r="13" fill="currentColor" fill-opacity="0.35" stroke="none"/><path d="M14 16 q12 -4 24 0 M13 22 q13 -3 26 1 M16 28 q10 -3 20 0" stroke-opacity="0.6" stroke-width="1.4"/>`,
    ),
  },
};

export const WEAR_ICONS = {
  none: P(`<path d="M14 20 h24" stroke-opacity="0.5"/>`),
  clothes: {
    none: P(`<path d="M16 14 l20 12 M36 14 l-20 12" stroke-opacity="0.5"/>`),
    tshirt: P(`<path d="M18 7 l-9 6 l4 6 l4 -2 v16 h18 v-16 l4 2 l4 -6 l-9 -6 q-8 5 -16 0 z" ${SOFT}/>`),
    hawaiian: P(
      `<path d="M18 7 l-9 6 l4 6 l4 -2 v16 h18 v-16 l4 2 l4 -6 l-9 -6 l-8 8 z" ${SOFT}/><circle cx="21" cy="22" r="2" fill="currentColor"/><circle cx="31" cy="28" r="2" fill="currentColor"/><path d="M26 15 v18"/>`,
    ),
    suit: P(
      `<path d="M18 7 l-6 4 v22 h28 v-22 l-6 -4 l-8 10 z" ${SOFT}/><path d="M22 7 l4 10 l4 -10"/><path d="M23 12 l3 -2 l3 2 l-3 2 z" fill="currentColor"/>`,
    ),
    santa: P(
      `<path d="M18 7 l-6 4 v22 h28 v-22 l-6 -4 q-8 5 -16 0 z" ${SOFT}/><path d="M12 24 h28" stroke-width="4"/><rect x="23" y="21.5" width="6" height="5" rx="1"/><path d="M12 33 h28" stroke-width="3"/>`,
    ),
    elf: P(
      `<path d="M18 7 l-6 4 v16 h28 v-16 l-6 -4 q-8 5 -16 0 z" ${SOFT}/><path d="M12 27 l4 6 l4 -6 l4 6 l4 -6 l4 6 l4 -6 l4 6"/>`,
    ),
    vampire: P(
      `<path d="M12 33 v-20 l6 -6 l8 8 l8 -8 l6 6 v20 z" ${SOFT}/><path d="M12 13 l-4 -8 l10 2 M40 13 l4 -8 l-10 2"/>`,
    ),
    witch: P(
      `<path d="M19 7 h14 l4 14 l5 12 l-4 -3 l-4 3 l-4 -3 l-4 3 l-4 -3 l-4 3 l-4 -3 l-4 3 l5 -12 z" ${SOFT}/><path d="M17 20 h18"/>`,
    ),
    dress: P(
      `<path d="M20 6 h12 l2 10 l8 17 h-32 l8 -17 z" ${SOFT}/><circle cx="20" cy="27" r="1.5" fill="currentColor"/><circle cx="30" cy="24" r="1.5" fill="currentColor"/><circle cx="34" cy="30" r="1.5" fill="currentColor"/>`,
    ),
    swimsuit: P(`<path d="M19 6 v8 q7 4 14 0 v-8 M18 14 q8 18 16 0 l4 14 h-24 z" ${SOFT}/>`),
    tutu: P(
      `<rect x="20" y="6" width="12" height="12" rx="3"/><path d="M10 26 q4 -6 8 0 q4 -6 8 0 q4 -6 8 0 q4 -6 8 0 l-4 6 h-24 z" ${SOFT}/>`,
    ),
  },
  neck: {
    none: P(`<path d="M16 14 l20 12 M36 14 l-20 12" stroke-opacity="0.5"/>`),
    scarf: P(`<path d="M12 14 q14 8 28 0 v6 q-14 8 -28 0 z" ${SOFT}/><path d="M30 20 l2 14 h6 l-2 -15"/>`),
    tie: P(`<path d="M22 6 h8 l-2 5 h-4 z" fill="currentColor"/><path d="M24 11 h4 l4 16 l-6 6 l-6 -6 z" ${SOFT}/>`),
    bow: P(
      `<path d="M26 20 l-12 -8 v16 z M26 20 l12 -8 v16 z" ${SOFT}/><circle cx="26" cy="20" r="3" fill="currentColor"/>`,
    ),
    pearls: P(`<path d="M10 10 q16 26 32 0" stroke-dasharray="0.1 5" stroke-width="4.5"/>`),
    lei: P(
      `<circle cx="12" cy="14" r="3.5" ${SOFT}/><circle cx="16" cy="24" r="3.5" ${SOFT}/><circle cx="26" cy="29" r="3.5" ${SOFT}/><circle cx="36" cy="24" r="3.5" ${SOFT}/><circle cx="40" cy="14" r="3.5" ${SOFT}/>`,
    ),
  },
  extra: {
    none: P(`<path d="M16 14 l20 12 M36 14 l-20 12" stroke-opacity="0.5"/>`),
    gift: P(
      `<rect x="13" y="14" width="26" height="19" rx="2" ${SOFT}/><path d="M26 14 v19 M13 21 h26 M26 14 q-8 -8 -8 -2 q0 3 8 2 q8 1 8 -2 q0 -6 -8 2"/>`,
    ),
    candycane: P(
      `<path d="M22 35 V14 a6 6 0 0 1 12 0 v3" stroke-width="4"/><path d="M20 30 l4 -2 M20 23 l4 -2 M20 16 l4 -2" stroke-width="1.6"/>`,
    ),
    pumpkin: P(
      `<ellipse cx="26" cy="23" rx="14" ry="11" ${SOFT}/><path d="M26 12 v-5"/><path d="M19 21 l3 -3 l3 3 M27 21 l3 -3 l3 3 M20 27 q6 4 12 0"/>`,
    ),
    icecream: P(
      `<path d="M19 18 l7 17 l7 -17 z" ${SOFT}/><circle cx="23" cy="13" r="5"/><circle cx="30" cy="12" r="5"/>`,
    ),
    balloon: P(`<ellipse cx="26" cy="14" rx="9" ry="11" ${SOFT}/><path d="M26 25 q-3 5 0 11"/>`),
    cape: P(`<path d="M18 6 h16 l6 28 q-14 -4 -28 0 z" ${SOFT}/>`),
    wings: P(
      `<path d="M26 20 q-14 -18 -18 -4 q0 10 18 4 q-12 12 -4 14 q4 0 4 -14 q14 -18 18 -4 q0 10 -18 4 q12 12 4 14 q-4 0 -4 -14" ${SOFT}/>`,
    ),
    batwings: P(
      `<path d="M26 18 l-18 -8 q2 8 -2 12 q6 -2 8 4 q4 -6 12 -8 z M26 18 l18 -8 q-2 8 2 12 q-6 -2 -8 4 q-4 -6 -12 -8 z" ${SOFT}/>`,
    ),
    surfboard: P(
      `<ellipse cx="26" cy="20" rx="7" ry="16" transform="rotate(30 26 20)" ${SOFT}/><path d="M18 30 l16 -20"/>`,
    ),
    backpack: P(
      `<rect x="14" y="9" width="24" height="26" rx="6" ${SOFT}/><rect x="18" y="22" width="16" height="9" rx="2"/><path d="M20 9 q6 -6 12 0"/>`,
    ),
  },
  specs: {
    none: P(`<path d="M16 14 l20 12 M36 14 l-20 12" stroke-opacity="0.5"/>`),
    sunglasses: P(
      `<rect x="8" y="14" width="15" height="11" rx="4" fill="currentColor"/><rect x="29" y="14" width="15" height="11" rx="4" fill="currentColor"/><path d="M23 17 h6"/>`,
    ),
    heart: P(
      `<path d="M15 26 l-7 -7 a4 4 0 0 1 7 -5 a4 4 0 0 1 7 5 z M37 26 l-7 -7 a4 4 0 0 1 7 -5 a4 4 0 0 1 7 5 z" fill="currentColor" fill-opacity="0.6"/><path d="M22 18 h8"/>`,
    ),
    round: P(`<circle cx="16" cy="20" r="7"/><circle cx="36" cy="20" r="7"/><path d="M23 19 h6"/>`),
    star: P(
      `<path d="M16 11 l2.5 6 l6 .5 l-4.5 4 l1.5 6 l-5.5 -3.5 l-5.5 3.5 l1.5 -6 l-4.5 -4 l6 -.5 z M36 11 l2.5 6 l6 .5 l-4.5 4 l1.5 6 l-5.5 -3.5 l-5.5 3.5 l1.5 -6 l-4.5 -4 l6 -.5 z" ${SOFT}/>`,
    ),
    eyepatch: P(
      `<circle cx="34" cy="20" r="7" fill="currentColor"/><path d="M8 12 l40 14"/><circle cx="17" cy="20" r="3"/>`,
    ),
  },
};
// hairstyles, on the On top tab
KIT_ICONS.top.pigtails = P(
  `<path d="M14 24 a12 12 0 0 1 24 0" ${SOFT}/><circle cx="10" cy="24" r="5" ${SOFT}/><circle cx="42" cy="24" r="5" ${SOFT}/><path d="M14 34 h24"/>`,
);
KIT_ICONS.top.ponytail = P(
  `<path d="M14 24 a12 12 0 0 1 24 0" ${SOFT}/><path d="M37 18 q10 4 6 16" stroke-width="4"/><path d="M14 34 h24"/>`,
);
KIT_ICONS.top.spiky = P(
  `<path d="M12 26 l4 -12 l4 8 l4 -12 l4 12 l4 -10 l4 8 l4 -10 l2 16 z" ${SOFT}/><path d="M12 34 h28"/>`,
);
KIT_ICONS.top.curly = P(
  `<circle cx="16" cy="22" r="5" ${SOFT}/><circle cx="24" cy="16" r="5" ${SOFT}/><circle cx="32" cy="16" r="5" ${SOFT}/><circle cx="38" cy="23" r="5" ${SOFT}/><path d="M12 34 h28"/>`,
);
