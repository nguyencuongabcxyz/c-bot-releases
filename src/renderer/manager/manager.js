/* global cbot */
(() => {
  const $ = (sel) => document.querySelector(sel);
  const COLORS = ['#5ac8fa', '#ff9f43', '#7bed9f', '#ff6b81', '#a29bfe', '#feca57', '#c8d6e5', '#ffffff'];
  const ACCESSORIES = {
    none: 'None',
    hardhat: '👷 Hard hat',
    glasses: '🤓 Glasses',
    bowtie: '🎀 Bow tie',
    tophat: '🎩 Top hat',
    crown: '👑 Crown',
    headphones: '🎧 Headphones',
    flower: '🌸 Flower',
    pirate: '🏴‍☠️ Pirate hat',
    gradcap: '🎓 Graduation cap', // a reward: shown once you've learnt 10 English words
    santa: 'Santa hat',
    elf: 'Elf hat',
    antlers: 'Reindeer antlers',
    witch: 'Witch hat',
    horns: 'Devil horns',
    sunhat: 'Sun hat',
    strawhat: 'Straw hat',
    partyhat: 'Party hat',
    tiara: 'Tiara',
    hairbow: 'Hair bow',
    maidcap: 'Maid headband',
    beanie: 'Beanie',
  };
  const SIZES = { small: '🐭 Small', normal: '🙂 Normal', large: '🦒 Large', huge: '🐘 Huge' };
  const SOUNDS_HINT = {
    essential: 'An answer is ready, a question for you, an error, a reminder, and a sound when you play with it. Quiet while you present or share your screen.',
    all: 'Every sound: chatter while it answers, each step, its antics and snores, the robots together.',
    off: 'No sounds at all, and no word read aloud.',
  };
  // desk themes (office3d/themes.js); picking one also picks its paint job
  const THEMES = { classic: { label: '🎨 Classic' }, sioux: { label: '⛺ Sioux Connect', paint: '#F47920' } };

  // ---- the robot builder (office3d/kit3d.js builds it; these are its parts)
  const KIT_SLOTS = {
    head: ['Head', { box: 'Rounded box', ball: 'Ball', dome: 'Dome', capsule: 'Capsule', tv: 'Old TV', bucket: 'Bucket' }],
    face: ['Face', { dots: 'Classic', cute: 'Cute', visor: 'Visor', cyclops: 'Cyclops', pixel: 'Pixel' }],
    top: ['On top', { antenna: 'Antenna', twin: 'Twin antennas', ears: 'Cat ears', propeller: 'Propeller', dish: 'Dish', bulb: 'Light bulb', pigtails: 'Pigtails', ponytail: 'Ponytail', spiky: 'Spiky hair', curly: 'Curly hair', none: 'Nothing' }],
    body: ['Body', { box: 'Box', barrel: 'Barrel', egg: 'Egg', slim: 'Slim', chunky: 'Chunky' }],
    arms: ['Arms', { classic: 'Classic', noodle: 'Noodle', mitten: 'Mittens', claw: 'Claws' }],
    base: ['Stands on', { legs: 'Legs', wheel: 'A wheel', treads: 'Treads', hover: 'A jet', spring: 'A spring' }],
    finish: ['Finish', { matte: 'Matte', glossy: 'Glossy', metal: 'Metal', wood: 'Painted wood' }],
  };
  const KIT_DEFAULT = {
    head: 'box', face: 'dots', top: 'antenna', body: 'box', arms: 'classic', base: 'legs', finish: 'matte',
    clothes: 'none', neck: 'none', extra: 'none', specs: 'none',
    second: '#8a90a6', accent: '#ff5e62', eye: '', cloth: '#4a90e2', hair: '#5a3a22',
  };
  // what it wears (office3d/kitwear.js), in the Outfit tab
  const WEAR_SLOTS = {
    clothes: ['Clothes', { none: 'Nothing', tshirt: 'T-shirt', hawaiian: 'Hawaiian shirt', suit: 'Suit', santa: 'Santa suit', elf: 'Elf tunic', vampire: 'Vampire', witch: 'Witch dress', dress: 'Dress', swimsuit: 'Swimsuit', tutu: 'Tutu', maid: 'Maid dress' }],
    neck: ['Round its neck', { none: 'Nothing', scarf: 'Scarf', tie: 'Tie', bow: 'Bow', pearls: 'Pearls', lei: 'Flower lei' }],
    extra: ['Holding, or on its back', { none: 'Nothing', gift: 'A present', candycane: 'Candy cane', pumpkin: 'Pumpkin bucket', icecream: 'Ice cream', balloon: 'Balloon', cape: 'Cape', wings: 'Fairy wings', batwings: 'Bat wings', surfboard: 'Surfboard', backpack: 'Backpack', duster: 'Feather duster' }],
    specs: ['Glasses', { none: 'Nothing', sunglasses: 'Sunglasses', heart: 'Heart shades', round: 'Round glasses', star: 'Star glasses', eyepatch: 'Eye patch' }],
  };
  // themed looks: a hat (the Accessory) and what it wears, for a boy and a girl
  const GIRL_HAIR = ['pigtails', 'ponytail', 'curly'];
  const LOOKS = [
    ['Christmas', [
      ['Santa', 'boy', { accessory: 'santa', clothes: 'santa', neck: 'none', extra: 'gift', specs: 'none' }],
      ['Elf', 'girl', { accessory: 'elf', clothes: 'elf', neck: 'bow', extra: 'candycane', specs: 'none', top: 'pigtails' }],
    ]],
    ['Halloween', [
      ['Vampire', 'boy', { accessory: 'none', clothes: 'vampire', neck: 'none', extra: 'cape', specs: 'none' }],
      ['Witch', 'girl', { accessory: 'witch', clothes: 'witch', neck: 'none', extra: 'pumpkin', specs: 'none', top: 'ponytail' }],
    ]],
    ['Beach', [
      ['Surfer', 'boy', { accessory: 'strawhat', clothes: 'hawaiian', neck: 'lei', extra: 'surfboard', specs: 'sunglasses', cloth: '#36c2d9' }],
      ['Beach day', 'girl', { accessory: 'sunhat', clothes: 'swimsuit', neck: 'lei', extra: 'icecream', specs: 'heart', cloth: '#ff6fa5', top: 'pigtails' }],
    ]],
    ['Party', [
      ['Gentleman', 'boy', { accessory: 'tophat', clothes: 'suit', neck: 'none', extra: 'balloon', specs: 'round' }],
      ['Princess', 'girl', { accessory: 'tiara', clothes: 'dress', neck: 'pearls', extra: 'wings', specs: 'none', cloth: '#c77dff', top: 'curly' }],
    ]],
    ['Winter', [
      ['Snow day', 'boy', { accessory: 'beanie', clothes: 'tshirt', neck: 'scarf', extra: 'backpack', specs: 'none', cloth: '#3a7bd5' }],
      ['Snow day', 'girl', { accessory: 'hairbow', clothes: 'dress', neck: 'scarf', extra: 'gift', specs: 'none', cloth: '#a8d8ff', top: 'pigtails' }],
    ]],
  ];
  const KIT_PRESETS = {
    classic: ['Classic bot', {}, null],
    cat: ['Cat-bot', { head: 'ball', face: 'cute', top: 'ears', body: 'egg', arms: 'mitten', finish: 'glossy', second: '#f4d7b8', accent: '#ff8fb1' }, '#f5a25d'],
    nerd: ['Nerd-bot', { face: 'visor', body: 'slim', arms: 'claw', base: 'treads', second: '#5f6b7a', accent: '#7bed9f', eye: '#7bed9f' }, '#a29bfe'],
    cutie: ['Cutie-bot', { head: 'capsule', face: 'cute', top: 'bulb', body: 'egg', arms: 'mitten', base: 'hover', finish: 'glossy', second: '#ffd1e3', accent: '#ff8fb1', eye: '#ff9ecf' }, '#ff8fb1'],
    rover: ['Rover', { head: 'dome', face: 'cyclops', top: 'dish', body: 'barrel', arms: 'claw', base: 'wheel', finish: 'metal', second: '#5f6b7a', accent: '#ffb347' }, '#c8d6e5'],
    retro: ['Retro TV', { head: 'tv', face: 'pixel', top: 'twin', arms: 'noodle', base: 'spring', finish: 'wood', second: '#6b4f2a', accent: '#ffd34d', eye: '#7bed9f' }, '#e2b07a'],
  };
  const KIT_COLOURS = ['#8a90a6', '#5f6b7a', '#1d2235', '#ffffff', '#ff5e62', '#ffb347', '#ffd34d', '#7bed9f', '#5ac8fa', '#a29bfe', '#ff8fb1', '#6b4f2a'];
  // little drawings of each part, for its tile (currentColor: the accent)
  const P = (body) => `<svg viewBox="0 0 52 40" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const SOFT = 'fill="currentColor" fill-opacity="0.18"';
  const KIT_ICONS = {
    head: {
      box: P(`<rect x="10" y="7" width="32" height="26" rx="8" ${SOFT}/><rect x="15" y="12" width="22" height="13" rx="4"/>`),
      ball: P(`<circle cx="26" cy="20" r="14" ${SOFT}/><path d="M17 20 a9 6 0 0 1 18 0"/>`),
      dome: P(`<path d="M11 33 V20 a15 15 0 0 1 30 0 V33 Z" ${SOFT}/><rect x="15" y="20" width="22" height="9" rx="3"/>`),
      capsule: P(`<rect x="16" y="4" width="20" height="32" rx="10" ${SOFT}/><rect x="19" y="15" width="14" height="10" rx="3"/>`),
      tv: P(`<rect x="8" y="8" width="36" height="25" rx="3" ${SOFT}/><rect x="12" y="12" width="22" height="17" rx="2"/><circle cx="39" cy="15" r="1.5"/><circle cx="39" cy="22" r="1.5"/><path d="M20 8 L16 3 M28 8 L32 3"/>`),
      bucket: P(`<path d="M10 8 H42 L38 34 H14 Z" ${SOFT}/><rect x="16" y="15" width="20" height="11" rx="3"/>`),
    },
    face: {
      dots: P(`<rect x="7" y="6" width="38" height="28" rx="8"/><ellipse cx="19" cy="17" rx="3" ry="4" fill="currentColor"/><ellipse cx="33" cy="17" rx="3" ry="4" fill="currentColor"/><path d="M21 25 q5 4 10 0"/>`),
      cute: P(`<rect x="7" y="6" width="38" height="28" rx="10"/><circle cx="18" cy="17" r="5" fill="currentColor"/><circle cx="34" cy="17" r="5" fill="currentColor"/><path d="M23 26 q3 2.5 6 0"/>`),
      visor: P(`<rect x="7" y="6" width="38" height="28" rx="6"/><rect x="11" y="13" width="30" height="9" rx="4.5" ${SOFT}/><path d="M16 17.5 h5 M31 17.5 h5"/><path d="M23 28 h6"/>`),
      cyclops: P(`<rect x="7" y="6" width="38" height="28" rx="8"/><circle cx="26" cy="17" r="6"/><circle cx="26" cy="17" r="2.2" fill="currentColor"/><path d="M22 28 q4 3 8 0"/>`),
      pixel: P(`<rect x="7" y="6" width="38" height="28" rx="3"/><rect x="15" y="12" width="5" height="7" fill="currentColor" stroke="none"/><rect x="32" y="12" width="5" height="7" fill="currentColor" stroke="none"/><path d="M19 25 h3 v2 h8 v-2 h3" stroke-linecap="square"/>`),
    },
    top: {
      antenna: P(`<path d="M26 34 V14"/><circle cx="26" cy="10" r="4" fill="currentColor"/><path d="M14 34 h24"/>`),
      twin: P(`<path d="M22 34 L16 14 M30 34 L36 14"/><circle cx="15" cy="11" r="3" fill="currentColor"/><circle cx="37" cy="11" r="3" fill="currentColor"/><path d="M12 34 h28"/>`),
      ears: P(`<path d="M12 34 L16 10 L25 30 M40 34 L36 10 L27 30" ${SOFT}/><path d="M12 34 h28"/>`),
      propeller: P(`<path d="M26 34 V18 M12 15 h28"/><circle cx="26" cy="15" r="2.5" fill="currentColor"/><path d="M12 34 h28"/>`),
      dish: P(`<path d="M26 34 V22"/><path d="M14 12 a12 9 0 0 0 24 6 Z" ${SOFT}/><circle cx="31" cy="12" r="2" fill="currentColor"/><path d="M12 34 h28"/>`),
      bulb: P(`<circle cx="26" cy="15" r="9" ${SOFT}/><path d="M22 25 h8 v5 h-8 z"/><path d="M23 15 l3 3 l3 -3"/><path d="M12 34 h28"/>`),
      none: P(`<path d="M12 34 h28"/><path d="M20 16 l12 12 M32 16 l-12 12" stroke-opacity="0.5"/>`),
    },
    body: {
      box: P(`<rect x="13" y="6" width="26" height="28" rx="7" ${SOFT}/><circle cx="26" cy="16" r="2.5" fill="currentColor"/>`),
      barrel: P(`<path d="M14 8 h24 v24 h-24 z" ${SOFT}/><path d="M13 8 h26 M13 32 h26"/><circle cx="26" cy="17" r="2.5" fill="currentColor"/>`),
      egg: P(`<ellipse cx="26" cy="21" rx="12" ry="14" ${SOFT}/><circle cx="26" cy="17" r="2.5" fill="currentColor"/>`),
      slim: P(`<rect x="19" y="5" width="14" height="30" rx="7" ${SOFT}/><circle cx="26" cy="16" r="2.2" fill="currentColor"/>`),
      chunky: P(`<rect x="11" y="9" width="30" height="25" rx="5" ${SOFT}/><circle cx="10" cy="11" r="4"/><circle cx="42" cy="11" r="4"/><circle cx="26" cy="19" r="2.5" fill="currentColor"/>`),
    },
    arms: {
      classic: P(`<circle cx="12" cy="9" r="3"/><path d="M12 12 L14 22 L20 30"/><circle cx="22" cy="32" r="3.5" fill="currentColor"/><circle cx="40" cy="9" r="3"/><path d="M40 12 L38 22 L32 30"/><circle cx="30" cy="32" r="3.5" fill="currentColor"/>`),
      noodle: P(`<path d="M12 8 q-4 12 6 14 q8 2 4 10"/><path d="M40 8 q4 12 -6 14 q-8 2 -4 10"/><circle cx="22" cy="33" r="2" fill="currentColor"/><circle cx="30" cy="33" r="2" fill="currentColor"/>`),
      mitten: P(`<path d="M12 8 L15 22"/><ellipse cx="17" cy="29" rx="6" ry="5" ${SOFT}/><path d="M40 8 L37 22"/><ellipse cx="35" cy="29" rx="6" ry="5" ${SOFT}/>`),
      claw: P(`<path d="M12 8 L15 22"/><path d="M15 22 l-4 9 M15 22 l4 9"/><path d="M40 8 L37 22"/><path d="M37 22 l-4 9 M37 22 l4 9"/>`),
    },
    base: {
      legs: P(`<path d="M20 6 V22 L18 32 M32 6 V22 L34 32"/><path d="M13 33 h9 M30 33 h9"/>`),
      wheel: P(`<path d="M22 6 L24 22 M30 6 L28 22"/><circle cx="26" cy="28" r="7" ${SOFT}/><circle cx="26" cy="28" r="2" fill="currentColor"/>`),
      treads: P(`<path d="M18 6 V20 M34 6 V20"/><rect x="10" y="22" width="14" height="11" rx="5" ${SOFT}/><rect x="28" y="22" width="14" height="11" rx="5" ${SOFT}/>`),
      hover: P(`<path d="M16 8 h20 l-4 12 h-12 z" ${SOFT}/><path d="M22 23 l4 11 l4 -11" stroke-opacity="0.7"/>`),
      spring: P(`<path d="M26 5 V9 l-6 3 l12 4 l-12 4 l12 4 l-6 3 V31"/><path d="M17 34 h18"/>`),
    },
    finish: {
      matte: P(`<circle cx="26" cy="20" r="13" fill="currentColor" fill-opacity="0.45" stroke="none"/>`),
      glossy: P(`<circle cx="26" cy="20" r="13" fill="currentColor" fill-opacity="0.45" stroke="none"/><path d="M19 14 a8 8 0 0 1 7 -4" stroke="#fff" stroke-width="3"/>`),
      metal: P(`<circle cx="26" cy="20" r="13" fill="currentColor" fill-opacity="0.3" stroke="none"/><path d="M15 26 L33 10 M19 30 L37 14" stroke="#fff" stroke-opacity="0.8"/>`),
      wood: P(`<circle cx="26" cy="20" r="13" fill="currentColor" fill-opacity="0.35" stroke="none"/><path d="M14 16 q12 -4 24 0 M13 22 q13 -3 26 1 M16 28 q10 -3 20 0" stroke-opacity="0.6" stroke-width="1.4"/>`),
    },
  };

  const WEAR_ICONS = {
    none: P(`<path d="M14 20 h24" stroke-opacity="0.5"/>`),
    clothes: {
      none: P(`<path d="M16 14 l20 12 M36 14 l-20 12" stroke-opacity="0.5"/>`),
      tshirt: P(`<path d="M18 7 l-9 6 l4 6 l4 -2 v16 h18 v-16 l4 2 l4 -6 l-9 -6 q-8 5 -16 0 z" ${SOFT}/>`),
      hawaiian: P(`<path d="M18 7 l-9 6 l4 6 l4 -2 v16 h18 v-16 l4 2 l4 -6 l-9 -6 l-8 8 z" ${SOFT}/><circle cx="21" cy="22" r="2" fill="currentColor"/><circle cx="31" cy="28" r="2" fill="currentColor"/><path d="M26 15 v18"/>`),
      suit: P(`<path d="M18 7 l-6 4 v22 h28 v-22 l-6 -4 l-8 10 z" ${SOFT}/><path d="M22 7 l4 10 l4 -10"/><path d="M23 12 l3 -2 l3 2 l-3 2 z" fill="currentColor"/>`),
      santa: P(`<path d="M18 7 l-6 4 v22 h28 v-22 l-6 -4 q-8 5 -16 0 z" ${SOFT}/><path d="M12 24 h28" stroke-width="4"/><rect x="23" y="21.5" width="6" height="5" rx="1"/><path d="M12 33 h28" stroke-width="3"/>`),
      elf: P(`<path d="M18 7 l-6 4 v16 h28 v-16 l-6 -4 q-8 5 -16 0 z" ${SOFT}/><path d="M12 27 l4 6 l4 -6 l4 6 l4 -6 l4 6 l4 -6 l4 6"/>`),
      vampire: P(`<path d="M12 33 v-20 l6 -6 l8 8 l8 -8 l6 6 v20 z" ${SOFT}/><path d="M12 13 l-4 -8 l10 2 M40 13 l4 -8 l-10 2"/>`),
      witch: P(`<path d="M19 7 h14 l4 14 l5 12 l-4 -3 l-4 3 l-4 -3 l-4 3 l-4 -3 l-4 3 l-4 -3 l-4 3 l5 -12 z" ${SOFT}/><path d="M17 20 h18"/>`),
      dress: P(`<path d="M20 6 h12 l2 10 l8 17 h-32 l8 -17 z" ${SOFT}/><circle cx="20" cy="27" r="1.5" fill="currentColor"/><circle cx="30" cy="24" r="1.5" fill="currentColor"/><circle cx="34" cy="30" r="1.5" fill="currentColor"/>`),
      swimsuit: P(`<path d="M19 6 v8 q7 4 14 0 v-8 M18 14 q8 18 16 0 l4 14 h-24 z" ${SOFT}/>`),
      tutu: P(`<rect x="20" y="6" width="12" height="12" rx="3"/><path d="M10 26 q4 -6 8 0 q4 -6 8 0 q4 -6 8 0 q4 -6 8 0 l-4 6 h-24 z" ${SOFT}/>`),
    },
    neck: {
      none: P(`<path d="M16 14 l20 12 M36 14 l-20 12" stroke-opacity="0.5"/>`),
      scarf: P(`<path d="M12 14 q14 8 28 0 v6 q-14 8 -28 0 z" ${SOFT}/><path d="M30 20 l2 14 h6 l-2 -15"/>`),
      tie: P(`<path d="M22 6 h8 l-2 5 h-4 z" fill="currentColor"/><path d="M24 11 h4 l4 16 l-6 6 l-6 -6 z" ${SOFT}/>`),
      bow: P(`<path d="M26 20 l-12 -8 v16 z M26 20 l12 -8 v16 z" ${SOFT}/><circle cx="26" cy="20" r="3" fill="currentColor"/>`),
      pearls: P(`<path d="M10 10 q16 26 32 0" stroke-dasharray="0.1 5" stroke-width="4.5"/>`),
      lei: P(`<circle cx="12" cy="14" r="3.5" ${SOFT}/><circle cx="16" cy="24" r="3.5" ${SOFT}/><circle cx="26" cy="29" r="3.5" ${SOFT}/><circle cx="36" cy="24" r="3.5" ${SOFT}/><circle cx="40" cy="14" r="3.5" ${SOFT}/>`),
    },
    extra: {
      none: P(`<path d="M16 14 l20 12 M36 14 l-20 12" stroke-opacity="0.5"/>`),
      gift: P(`<rect x="13" y="14" width="26" height="19" rx="2" ${SOFT}/><path d="M26 14 v19 M13 21 h26 M26 14 q-8 -8 -8 -2 q0 3 8 2 q8 1 8 -2 q0 -6 -8 2"/>`),
      candycane: P(`<path d="M22 35 V14 a6 6 0 0 1 12 0 v3" stroke-width="4"/><path d="M20 30 l4 -2 M20 23 l4 -2 M20 16 l4 -2" stroke-width="1.6"/>`),
      pumpkin: P(`<ellipse cx="26" cy="23" rx="14" ry="11" ${SOFT}/><path d="M26 12 v-5"/><path d="M19 21 l3 -3 l3 3 M27 21 l3 -3 l3 3 M20 27 q6 4 12 0"/>`),
      icecream: P(`<path d="M19 18 l7 17 l7 -17 z" ${SOFT}/><circle cx="23" cy="13" r="5"/><circle cx="30" cy="12" r="5"/>`),
      balloon: P(`<ellipse cx="26" cy="14" rx="9" ry="11" ${SOFT}/><path d="M26 25 q-3 5 0 11"/>`),
      cape: P(`<path d="M18 6 h16 l6 28 q-14 -4 -28 0 z" ${SOFT}/>`),
      wings: P(`<path d="M26 20 q-14 -18 -18 -4 q0 10 18 4 q-12 12 -4 14 q4 0 4 -14 q14 -18 18 -4 q0 10 -18 4 q12 12 4 14 q-4 0 -4 -14" ${SOFT}/>`),
      batwings: P(`<path d="M26 18 l-18 -8 q2 8 -2 12 q6 -2 8 4 q4 -6 12 -8 z M26 18 l18 -8 q-2 8 2 12 q-6 -2 -8 4 q-4 -6 -12 -8 z" ${SOFT}/>`),
      surfboard: P(`<ellipse cx="26" cy="20" rx="7" ry="16" transform="rotate(30 26 20)" ${SOFT}/><path d="M18 30 l16 -20"/>`),
      backpack: P(`<rect x="14" y="9" width="24" height="26" rx="6" ${SOFT}/><rect x="18" y="22" width="16" height="9" rx="2"/><path d="M20 9 q6 -6 12 0"/>`),
    },
    specs: {
      none: P(`<path d="M16 14 l20 12 M36 14 l-20 12" stroke-opacity="0.5"/>`),
      sunglasses: P(`<rect x="8" y="14" width="15" height="11" rx="4" fill="currentColor"/><rect x="29" y="14" width="15" height="11" rx="4" fill="currentColor"/><path d="M23 17 h6"/>`),
      heart: P(`<path d="M15 26 l-7 -7 a4 4 0 0 1 7 -5 a4 4 0 0 1 7 5 z M37 26 l-7 -7 a4 4 0 0 1 7 -5 a4 4 0 0 1 7 5 z" fill="currentColor" fill-opacity="0.6"/><path d="M22 18 h8"/>`),
      round: P(`<circle cx="16" cy="20" r="7"/><circle cx="36" cy="20" r="7"/><path d="M23 19 h6"/>`),
      star: P(`<path d="M16 11 l2.5 6 l6 .5 l-4.5 4 l1.5 6 l-5.5 -3.5 l-5.5 3.5 l1.5 -6 l-4.5 -4 l6 -.5 z M36 11 l2.5 6 l6 .5 l-4.5 4 l1.5 6 l-5.5 -3.5 l-5.5 3.5 l1.5 -6 l-4.5 -4 l6 -.5 z" ${SOFT}/>`),
      eyepatch: P(`<circle cx="34" cy="20" r="7" fill="currentColor"/><path d="M8 12 l40 14"/><circle cx="17" cy="20" r="3"/>`),
    },
  };
  // hairstyles, on the On top tab
  KIT_ICONS.top.pigtails = P(`<path d="M14 24 a12 12 0 0 1 24 0" ${SOFT}/><circle cx="10" cy="24" r="5" ${SOFT}/><circle cx="42" cy="24" r="5" ${SOFT}/><path d="M14 34 h24"/>`);
  KIT_ICONS.top.ponytail = P(`<path d="M14 24 a12 12 0 0 1 24 0" ${SOFT}/><path d="M37 18 q10 4 6 16" stroke-width="4"/><path d="M14 34 h24"/>`);
  KIT_ICONS.top.spiky = P(`<path d="M12 26 l4 -12 l4 8 l4 -12 l4 12 l4 -10 l4 8 l4 -10 l2 16 z" ${SOFT}/><path d="M12 34 h28"/>`);
  KIT_ICONS.top.curly = P(`<circle cx="16" cy="22" r="5" ${SOFT}/><circle cx="24" cy="16" r="5" ${SOFT}/><circle cx="32" cy="16" r="5" ${SOFT}/><circle cx="38" cy="23" r="5" ${SOFT}/><path d="M12 34 h28"/>`);

  const kitHistory = []; // earlier { kit, color, accessory }s, for Undo
  const PERMISSION_HINTS = {
    default: 'Can read and search files. Anything that changes things gets politely refused.',
    acceptEdits: 'Can read and edit files in its folder. Shell commands are still refused.',
    bypassPermissions: '⚠️ Can run any command and change anything without asking. Only for folders you trust it with.',
    plan: 'Investigates and proposes plans, but makes no changes.',
  };
  const CLICK_OPENS = { chat: '💬 Chat bubble', terminal: '⌨️ Terminal (full Claude Code)' };
  const CLICK_HINTS = {
    chat: 'The cartoon chat. You can still jump to the terminal with ⌨️ or /terminal.',
    terminal: 'Real Claude Code in a terminal window, with every command and prompt. The robot acts out what happens there.',
  };
  const WANDERS = { yes: '🚶 Now and then', no: '🪑 Stays at its desk' };
  const WANDER_HINTS = {
    yes: 'Left alone for a while it goes for a walk round the screen (asleep, it sleepwalks). Drag it back onto its desk to use it again.',
    no: 'It never leaves its desk.',
  };
  const NAMES = ['Sparky', 'Bolt', 'Widget', 'Pixel', 'Gizmo', 'Rusty', 'Beep', 'Nugget', 'Sprocket', 'Byte', 'Cogsworth', 'Zippy'];

  let state = { characters: [], personalities: {}, permissionModes: {}, settings: {} };
  let selected = null; // character id, or null for "new"
  let draft = null;

  window.Office3D.mount($('#preview'), { stateEl: $('#preview'), moodEl: $('#stage'), width: 300, height: 290 });

  // Show off the desk routine: what the robot does while Claude Code works.
  const DEMO = [
    { screen: 'idle', pose: 'idle', mouth: 'smile', eyes: 'open', label: 'Waiting for a question' },
    { screen: 'think', pose: 'thinking', mouth: 'o', eyes: 'open', label: '🤔 Thinking', cls: 'thinking' },
    { screen: 'read', pose: 'reading', mouth: 'o', eyes: 'open', label: '📖 Reading a file' },
    { screen: 'search', pose: 'reading', mouth: 'o', eyes: 'open', label: '🔍 Searching the code' },
    { screen: 'edit', pose: 'typing', mouth: 'o', eyes: 'open', label: '✏️ Editing a file' },
    { screen: 'run', pose: 'typing', mouth: 'o', eyes: 'open', label: '⚙️ Running a command' },
    { screen: 'web', pose: 'reading', mouth: 'o', eyes: 'open', label: '🌐 Browsing the web' },
    { screen: 'agent', pose: 'reading', mouth: 'o', eyes: 'open', label: '🤖 Sending a helper bot' },
    { screen: 'plan', pose: 'typing', mouth: 'o', eyes: 'open', label: '✅ Making a plan' },
    { screen: 'talk', pose: 'talking', mouth: 'talk', eyes: 'open', label: '💬 Answering you', cls: 'talking' },
    { screen: 'done', pose: 'cheer', mouth: 'smile', eyes: 'happy', label: '🎉 Done!' },
    { screen: 'error', pose: 'idle', mouth: 'flat', eyes: 'dizzy', label: '😵 Something broke' },
    { screen: 'locked', pose: 'idle', mouth: 'flat', eyes: 'flat', label: '🔒 Not allowed to do that' },
  ];
  let demoStep = 0;
  function demo() {
    const d = DEMO[demoStep++ % DEMO.length];
    const p = $('#preview');
    Object.assign(p.dataset, { screen: d.screen, pose: d.pose, mouth: d.mouth, eyes: d.eyes });
    $('#stage').classList.toggle('thinking', d.cls === 'thinking');
    $('#stage').classList.toggle('talking', d.cls === 'talking');
    Icon.text($('#stage-activity'), d.label);
  }
  demo();
  setInterval(demo, 2600);

  function blankDraft() {
    const used = new Set(state.characters.map((c) => c.name));
    return {
      name: NAMES.find((n) => !used.has(n)) || 'Robo',
      folder: '',
      personality: 'cheerful',
      color: COLORS[state.characters.length % COLORS.length],
      accessory: 'none',
      body: 'kit',
      kit: { ...KIT_DEFAULT },
      theme: 'classic',
      size: 'normal',
      permissionMode: 'default',
      model: '',
      clickOpens: 'chat',
      wanders: true,
    };
  }

  // ---------------------------------------------------------------- render

  function renderList() {
    const ul = $('#robot-list');
    ul.innerHTML = '';
    if (!state.characters.length) {
      ul.innerHTML = '<li class="empty-list">No robots yet. Build your first one! →</li>';
      return;
    }
    for (const c of state.characters) {
      const li = document.createElement('li');
      li.className = c.id === selected ? 'selected' : '';
      const folder = c.folder.split(/[\\/]/).filter(Boolean).pop() || '';
      li.innerHTML = `
        <span class="dot" style="background:${c.color}">${Icon('bot')}</span>
        <span class="meta"><b></b><small></small></span>
        <button class="eye-toggle ${c.visible ? '' : 'off'}" title="${c.visible ? 'Put away' : 'Put on desktop'}">${Icon(c.visible ? 'eye' : 'moon')}</button>
        <button class="bin" title="Delete this robot">${Icon('trash')}</button>`;
      li.querySelector('b').textContent = c.name + (c.busy ? ' · working…' : '');
      li.querySelector('small').textContent = folder;
      li.addEventListener('click', () => select(c.id));
      li.querySelector('.eye-toggle').addEventListener('click', (e) => {
        e.stopPropagation();
        cbot.invoke('mgr:visible', c.id, !c.visible);
      });
      li.querySelector('.bin').addEventListener('click', (e) => {
        e.stopPropagation();
        deleteRobot(c.id, c.name);
      });
      ul.appendChild(li);
    }
  }

  function renderChips(container, options, value, onPick) {
    container.innerHTML = '';
    for (const [key, label] of Object.entries(options)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(key === value));
      b.textContent = String(label).replace(/^(?:\p{Extended_Pictographic}|\uFE0F|\u200D)+\s*/u, ''); // (words only: clean chips)
      b.addEventListener('click', () => onPick(key));
      container.appendChild(b);
    }
  }

  function renderEditor() {
    const isNew = !selected;
    const c = state.characters.find((x) => x.id === selected);
    $('#editor-title').textContent = isNew ? 'New robot' : `Tuning up ${c.name}`;
    $('#f-name').value = draft.name;

    const folderEl = $('#f-folder');
    folderEl.textContent = draft.folder || 'No folder yet';
    folderEl.title = draft.folder;
    folderEl.classList.toggle('empty', !draft.folder);

    renderChips(
      $('#f-personality'),
      Object.fromEntries(Object.entries(state.personalities).map(([k, p]) => [k, `${p.emoji} ${p.label}`])),
      draft.personality,
      (k) => update({ personality: k })
    );
    renderChips($('#f-size'), SIZES, draft.size || 'normal', (k) => update({ size: k }));
    renderChips(
      $('#f-theme'),
      Object.fromEntries(Object.entries(THEMES).map(([k, t]) => [k, t.label])),
      draft.theme || 'classic',
      (k) => update({ theme: k, ...(THEMES[k].paint ? { color: THEMES[k].paint } : {}) })
    );
    renderKit();
    const unlocked = Object.fromEntries(Object.entries(ACCESSORIES).filter(([k]) => k !== 'gradcap' || state.settings.vocabRewards?.gradcap || draft.accessory === k));
    renderChips($('#f-accessory'), unlocked, draft.accessory || 'none', (k) => update({ accessory: k }));
    renderChips($('#f-click'), CLICK_OPENS, draft.clickOpens || 'chat', (k) => update({ clickOpens: k }));
    $('#click-hint').textContent = CLICK_HINTS[draft.clickOpens || 'chat'];
    const wander = draft.wanders === false ? 'no' : 'yes';
    renderChips($('#f-wander'), WANDERS, wander, (k) => update({ wanders: k === 'yes' }));
    $('#wander-hint').textContent = WANDER_HINTS[wander];

    const sw = $('#f-color');
    sw.innerHTML = '';
    for (const col of COLORS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.style.background = col;
      b.title = col;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(col.toLowerCase() === draft.color.toLowerCase()));
      b.addEventListener('click', () => update({ color: col }));
      sw.appendChild(b);
    }
    const custom = document.createElement('input');
    custom.type = 'color';
    custom.value = draft.color;
    custom.title = 'Custom paint';
    custom.addEventListener('input', () => update({ color: custom.value }, { keepColorInput: true }));
    sw.appendChild(custom);

    const perm = $('#f-permission');
    perm.innerHTML = '';
    for (const [k, label] of Object.entries(state.permissionModes)) perm.add(new Option(label, k, false, k === draft.permissionMode));
    $('#f-model').value = draft.model || '';
    const hint = $('#perm-hint');
    hint.textContent = PERMISSION_HINTS[draft.permissionMode] || '';
    hint.classList.toggle('warn', draft.permissionMode === 'bypassPermissions');

    $('#save').textContent = isNew ? 'Build it!' : 'Save changes';
    $('#toggle-visible').hidden = isNew;
    $('#forget').hidden = isNew;
    $('#delete').hidden = isNew;
    document.querySelector('.danger-zone').hidden = isNew;
    if (!isNew) $('#toggle-visible').textContent = c.visible ? 'Put away' : 'Put on desktop';

    $('#stats').textContent = isNew
      ? ''
      : `Asked ${c.stats?.questions || 0} question${c.stats?.questions === 1 ? '' : 's'} · poked ${c.stats?.pokes || 0} time${c.stats?.pokes === 1 ? '' : 's'}` +
        (c.stats?.costUsd ? ` · $${c.stats.costUsd.toFixed(2)} of thinking` : '');
    renderPreview();
  }

  function renderPreview() {
    const stage = $('#stage');
    stage.style.setProperty('--paint', draft.color);
    $('#preview').dataset.acc = draft.accessory || 'none';
    $('#preview').dataset.body = draft.body || 'loopy';
    $('#preview').dataset.kit = JSON.stringify(draft.kit || {});
    $('#preview').dataset.theme = draft.theme || 'classic';
    $('#preview').dataset.name = draft.name;
    const p = state.personalities[draft.personality];
    $('#stage-speech').textContent = draft.name ? `${p?.emoji || ''} Hi, I'm ${draft.name}!` : 'Give me a name!';
  }

  // Where Claude Code is. It's found by itself almost always (main findClaude.js);
  // if not: search again after installing it, an install command to copy, or pick it by hand.
  const WIN = /Windows/i.test(navigator.userAgent);
  const INSTALL = WIN ? 'irm https://claude.ai/install.ps1 | iex' : 'curl -fsSL https://claude.ai/install.sh | bash';
  let claudeNote = ''; // what the last search or pick said
  function renderClaude() {
    const el = $('#claude-status');
    const found = !!state.claudePath;
    el.innerHTML = found
      ? '<span class="ok">● Claude Code found</span><code class="path"></code><small class="from"></small>'
      : `<span class="bad">● Claude Code not found</span>
         <small>I looked everywhere it usually goes. Install it (${WIN ? 'in PowerShell' : 'in a terminal'}), then search again:</small>
         <div class="install"><code></code><button type="button" class="copy" title="Copy">Copy</button></div>`;
    if (found) {
      el.querySelector('.path').textContent = state.claudePath;
      el.querySelector('.from').textContent = state.claudeSource ? `from: ${state.claudeSource}` : '';
    } else {
      el.querySelector('.install code').textContent = INSTALL;
      el.querySelector('.copy').addEventListener('click', async (e) => {
        try {
          await navigator.clipboard.writeText(INSTALL);
          e.target.textContent = 'Copied!';
        } catch {
          e.target.textContent = 'Select it ↑';
        }
      });
    }
    const row = document.createElement('div');
    row.className = 'row';
    const search = document.createElement('button');
    search.type = 'button';
    search.textContent = found ? 'Search again' : '🔍 Search again';
    search.addEventListener('click', async () => {
      search.disabled = true;
      search.textContent = 'Searching…';
      const r = await cbot.invoke('mgr:find-claude');
      claudeNote = r.claudePath ? '' : 'Still not found. Did the install finish?';
      Object.assign(state, r);
      renderClaude();
    });
    const pick = document.createElement('button');
    pick.type = 'button';
    pick.textContent = found ? 'Change…' : 'Locate it myself…';
    pick.addEventListener('click', async () => {
      const r = await cbot.invoke('mgr:pick-claude');
      if (!r.ok && !r.error) return; // cancelled
      claudeNote = r.ok ? '' : r.error;
      if (r.ok) Object.assign(state, { claudePath: r.path, claudeSource: 'picked by you' });
      renderClaude();
    });
    row.append(search, pick);
    el.appendChild(row);
    if (claudeNote) {
      const note = document.createElement('small');
      note.className = 'bad';
      note.textContent = claudeNote;
      el.appendChild(note);
    }
  }

  function renderSettings() {
    renderClaude();
    renderHotkeys();
    // the sidebar's reminder of the one hotkey to remember
    const menu = (state.hotkeys || []).find((h) => h.setting === 'paletteHotkey');
    if (menu) Icon.text($('#side-hotkey'), `⌨️ ${menu.key}: every action`);
    $('#side-hotkey').classList.toggle('bad', menu?.ok === false);
    $('#drone').checked = state.settings.paletteDrone !== false;
    const sounds = ['all', 'off'].includes(state.settings.sounds) ? state.settings.sounds : 'essential';
    $('#sounds').value = sounds;
    $('#sounds-hint').textContent = SOUNDS_HINT[sounds];
    $('#theme').value = state.settings.theme === 'vintage' ? 'vintage' : 'future';
    $('#theme-mode').value = ['light', 'dark'].includes(state.settings.themeMode) ? state.settings.themeMode : 'auto';
    renderNotesSettings();
  }

  // ---- the Settings page: opened from the sidebar, it takes the place of the robot editor
  function showSettings(open) {
    document.querySelector('main').classList.toggle('settings-open', open);
    $('#app-settings').hidden = !open;
    $('#open-settings').setAttribute('aria-pressed', String(open));
  }
  $('#open-settings').addEventListener('click', () => showSettings($('#app-settings').hidden));
  $('#close-settings').addEventListener('click', () => showSettings(false));
  $('#side-hotkey').addEventListener('click', () => showSettings(true));
  $('#drone').addEventListener('change', (e) => cbot.invoke('mgr:settings', { paletteDrone: e.target.checked }));

  // ---- shortcuts: every hotkey, its keys (click to record new ones), whether it works
  let recording = null; // { setting, button } while you're pressing new keys
  const KEY_NAMES = { ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', '+': 'Plus' };
  function renderHotkeys() {
    const box = $('#hotkeys');
    if (recording) return; // (don't redraw under the one you're recording)
    box.innerHTML = '';
    for (const h of state.hotkeys || []) {
      const row = document.createElement('div');
      row.className = 'hk';
      row.innerHTML = '<div class="hk-what"><b></b><small></small></div><button type="button" class="hk-key"></button><span class="hk-state"></span><button type="button" class="hk-reset"></button>';
      row.querySelector('b').textContent = h.label;
      row.querySelector('small').textContent = h.what;
      const key = row.querySelector('.hk-key');
      key.textContent = h.key;
      key.title = 'Click, then press the new keys';
      key.addEventListener('click', () => startRecording(h, key));
      const st = row.querySelector('.hk-state');
      Icon.text(st, h.ok ? '✅ Works' : '⚠️ Taken by another app');
      st.classList.toggle('bad', !h.ok);
      const reset = row.querySelector('.hk-reset');
      reset.innerHTML = Icon('reset', 'sm');
      reset.title = `Back to ${h.def}`;
      reset.hidden = h.key === h.def;
      reset.addEventListener('click', () => cbot.invoke('mgr:settings', { [h.setting]: '' }));
      box.append(row);
    }
  }
  function startRecording(h, button) {
    stopRecording();
    recording = { setting: h.setting, button, was: button.textContent };
    button.classList.add('recording');
    button.textContent = 'Press the keys…';
  }
  function stopRecording(save) {
    if (!recording) return;
    const { setting, button, was } = recording;
    recording = null;
    button.classList.remove('recording');
    if (save) {
      button.textContent = save;
      cbot.invoke('mgr:settings', { [setting]: save });
    } else button.textContent = was;
  }
  document.addEventListener('keydown', (e) => {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') return stopRecording();
    if (['Control', 'Alt', 'Shift', 'Meta', 'AltGraph'].includes(e.key)) return; // (wait for the real key)
    const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean);
    if (!e.ctrlKey && !e.altKey) {
      recording.button.textContent = 'Use Ctrl or Alt with it…';
      return;
    }
    const k = KEY_NAMES[e.key] || (/^F\d{1,2}$/.test(e.key) ? e.key : e.code.startsWith('Key') ? e.code.slice(3) : e.code.startsWith('Digit') ? e.code.slice(5) : e.key.length === 1 ? e.key.toUpperCase() : e.key);
    stopRecording([...mods, k].join('+'));
  }, true);
  document.addEventListener('click', (e) => recording && !e.target.closest('.hk-key') && stopRecording(), true);

  // ---- notes & reminders (main notes.js)
  const DAYS = [[1, 'M'], [2, 'T'], [3, 'W'], [4, 'T'], [5, 'F'], [6, 'S'], [0, 'S']];
  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const noteSet = (patch) => cbot.invoke('mgr:settings', patch);
  function renderNotesSettings() {
    const s = { ...(state.notes?.defaults || {}), ...state.settings };
    const typing = (el) => document.activeElement === el; // (don't fight what you're typing)
    $('#n-reminders').checked = s.notesReminders !== false;
    if (!typing($('#n-evening'))) $('#n-evening').value = s.notesEvening || '17:30';
    $('#n-morning').checked = s.notesMorning !== false;
    $('#n-carry').checked = s.notesCarry !== false;
    for (const el of ['#n-evening', '#n-morning', '#n-carry']) $(el).disabled = s.notesReminders === false;
    $('#n-days').replaceChildren(...DAYS.map(([d, l]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = l;
      b.setAttribute('aria-label', DAY_NAMES[d]);
      b.setAttribute('aria-pressed', String((s.notesWorkdays || []).includes(d)));
      b.addEventListener('click', () => {
        const days = new Set(s.notesWorkdays || []);
        days.has(d) ? days.delete(d) : days.add(d);
        noteSet({ notesWorkdays: [...days].sort() });
      });
      return b;
    }));
    const robotSel = $('#n-robot');
    robotSel.replaceChildren(new Option('the nearest robot', ''), ...state.characters.map((c) => new Option(c.name, c.id)));
    robotSel.value = state.characters.some((c) => c.id === s.notesRobot) ? s.notesRobot : '';
    $('#n-board').value = s.notesBoard === 'one' ? 'one' : 'all';
    $('#n-board').disabled = !robotSel.value;
  }
  $('#n-reminders').addEventListener('change', (e) => noteSet({ notesReminders: e.target.checked }));
  $('#n-evening').addEventListener('change', (e) => e.target.value && noteSet({ notesEvening: e.target.value }));
  $('#n-morning').addEventListener('change', (e) => noteSet({ notesMorning: e.target.checked }));
  $('#n-carry').addEventListener('change', (e) => noteSet({ notesCarry: e.target.checked }));
  $('#n-robot').addEventListener('change', (e) => noteSet({ notesRobot: e.target.value }));
  $('#n-board').addEventListener('change', (e) => noteSet({ notesBoard: e.target.value }));

  // ---------------------------------------------------------------- actions

  function update(patch, { keepColorInput = false } = {}) {
    Object.assign(draft, patch);
    $('#form-error').textContent = '';
    if (keepColorInput) {
      renderPreview();
      document.querySelectorAll('#f-color button').forEach((b) => b.setAttribute('aria-checked', 'false'));
    } else {
      renderEditor();
    }
    wiggle();
  }

  // ---------------------------------------------------------------- the editor's panes, and the look

  // Look (the robot itself), Mind (personality, brain, what it may do…), Habits (wandering)
  let pane = 'look';
  function showPane(p) {
    pane = p;
    for (const b of document.querySelectorAll('.ed-tabs button')) b.setAttribute('aria-selected', String(b.dataset.pane === p));
    for (const s of document.querySelectorAll('.pane')) s.hidden = s.dataset.pane !== p;
  }
  for (const b of document.querySelectorAll('.ed-tabs button')) b.addEventListener('click', () => showPane(b.dataset.pane));

  // the look's own tabs: Shape (a part for each slot), Colours, Outfit, Size and desk
  let lookTab = 'shape';
  for (const b of document.querySelectorAll('.look-tabs button'))
    b.addEventListener('click', () => {
      lookTab = b.dataset.look;
      renderKit();
    });

  // A slot: its name, then its parts as a row of tiles that scrolls sideways (and stays
  // scrolled where it was when the look redraws)
  const rowScroll = new Map();
  function tileRow(key, label, parts, icons, value, onPick) {
    const slot = document.createElement('div');
    slot.className = 'slot';
    slot.innerHTML = '<h3></h3><div class="tile-row" role="radiogroup"></div>';
    slot.firstChild.textContent = label;
    const row = slot.lastChild;
    for (const [part, name] of Object.entries(parts)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'kit-tile';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(value === part));
      b.innerHTML = icons?.[part] || WEAR_ICONS.none;
      b.append(name);
      b.addEventListener('click', () => onPick(part));
      row.append(b);
    }
    row.addEventListener('scroll', () => rowScroll.set(key, row.scrollLeft));
    requestAnimationFrame(() => (row.scrollLeft = rowScroll.get(key) || 0));
    return slot;
  }

  function renderKit() {
    const kit = (draft.kit = { ...KIT_DEFAULT, ...(draft.kit || {}) });
    const presets = $('#kit-presets');
    presets.innerHTML = '';
    for (const [key, [label]] of Object.entries(KIT_PRESETS)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', () => applyPreset(key));
      presets.append(b);
    }
    for (const b of document.querySelectorAll('.look-tabs button')) b.setAttribute('aria-selected', String(b.dataset.look === lookTab));
    for (const s of document.querySelectorAll('.look-pane')) s.hidden = s.dataset.look !== lookTab;
    $('#kit-undo').disabled = !kitHistory.length;
    if (lookTab === 'shape') {
      const box = $('#look-shape');
      box.innerHTML = '';
      for (const slot of ['head', 'face', 'top', 'body', 'arms', 'base']) {
        const [label, parts] = KIT_SLOTS[slot];
        box.append(tileRow(slot, label, parts, KIT_ICONS[slot], kit[slot], (p) => setKit({ [slot]: p })));
      }
    } else if (lookTab === 'colours') renderKitColours(kit);
    else if (lookTab === 'outfit') renderOutfit(kit);
  }

  function renderKitColours(kit) {
    const box = $('#kit-colours');
    box.innerHTML = '';
    const row = (label, key, { auto } = {}) => {
      const r = document.createElement('div');
      r.className = 'slot';
      r.innerHTML = '<h3></h3><div class="swatches"></div>';
      r.firstChild.textContent = label;
      const sw = r.lastChild;
      if (auto) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'auto';
        b.textContent = auto;
        b.setAttribute('aria-checked', String(!kit[key]));
        b.addEventListener('click', () => setKit({ [key]: '' }));
        sw.append(b);
      }
      for (const col of KIT_COLOURS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.style.background = col;
        b.title = col;
        b.setAttribute('aria-checked', String((kit[key] || '').toLowerCase() === col));
        b.addEventListener('click', () => setKit({ [key]: col }));
        sw.append(b);
      }
      const custom = document.createElement('input');
      custom.type = 'color';
      custom.value = kit[key] || '#7ff3ff';
      custom.title = 'Any colour';
      custom.addEventListener('change', () => setKit({ [key]: custom.value }));
      sw.append(custom);
      box.append(r);
    };
    row('Arms and legs', 'second');
    row('Lights', 'accent');
    row('Eyes', 'eye', { auto: 'Like its brain' });
    row('Clothes', 'cloth');
    row('Hair', 'hair');
    const finish = $('#finish-row');
    finish.innerHTML = '';
    const [label, parts] = KIT_SLOTS.finish;
    finish.append(tileRow('finish', label, parts, KIT_ICONS.finish, kit.finish, (p) => setKit({ finish: p })));
  }

  // the Outfit tab: themed looks, the hat (the Accessory, rendered with the editor), then the rest
  function renderOutfit(kit) {
    const looks = $('#looks');
    looks.innerHTML = '';
    for (const [theme, pair] of LOOKS) {
      const label = document.createElement('span');
      label.textContent = theme;
      const row = document.createElement('div');
      row.className = 'pair';
      for (const [name, who, look] of pair) {
        const b = document.createElement('button');
        b.type = 'button';
        b.title = `A ${who}'s ${theme.toLowerCase()} look`;
        b.textContent = name;
        const tag = document.createElement('small');
        tag.textContent = ` · ${who}`;
        b.append(tag);
        b.addEventListener('click', () => wearLook(look, who));
        row.append(b);
      }
      looks.append(label, row);
    }
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'clear';
    clear.textContent = 'Take it all off';
    clear.addEventListener('click', () => wearLook({ accessory: 'none', clothes: 'none', neck: 'none', extra: 'none', specs: 'none' }));
    looks.append(document.createElement('span'), clear);
    const rows = $('#wear-rows');
    rows.innerHTML = '';
    for (const [slot, [label, parts]] of Object.entries(WEAR_SLOTS))
      rows.append(
        tileRow(slot, label, parts, WEAR_ICONS[slot], kit[slot] || 'none', (p) => {
          setKit({ [slot]: p });
          if (ON_ITS_BACK.includes(p)) peekBack();
        }),
      );
  }

  // a themed look: its hat goes in the Accessory; a girl's look does her hair if it isn't done
  function wearLook(look, who) {
    const { accessory, top, ...wear } = look;
    const patch = { ...wear };
    if (top && !GIRL_HAIR.includes(draft.kit.top)) patch.top = top;
    if (who === 'boy' && GIRL_HAIR.includes(draft.kit.top)) patch.top = 'spiky';
    kitHistory.push({ kit: { ...draft.kit }, color: draft.color, accessory: draft.accessory });
    update({ kit: { ...draft.kit, ...patch }, ...(accessory ? { accessory } : {}) });
  }

  // The preview faces you. Hold and drag it to turn it round (to see a cape, wings…); let go
  // and it turns back to face you. Picking something worn on its back shows it for a moment.
  const preview = $('#preview');
  let backTimer = 0;
  let turn = null; // { x, from, moved } while you're dragging it
  let turned = 0; // how far round it is, radians
  const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  function setTurn(a) {
    turned = wrapAngle(a);
    preview.dataset.facing = Math.abs(turned) < 0.01 ? 'camera' : turned.toFixed(3);
  }
  preview.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    clearTimeout(backTimer);
    turn = { x: e.clientX, from: turned, moved: false };
    preview.setPointerCapture(e.pointerId);
  });
  preview.addEventListener('pointermove', (e) => {
    if (!turn) return;
    const dx = e.clientX - turn.x;
    if (Math.abs(dx) > 4) turn.moved = true;
    if (!turn.moved) return;
    preview.classList.add('turning');
    preview.dataset.facingDrag = '1';
    setTurn(turn.from + dx * 0.012);
  });
  const letGo = () => {
    if (!turn) return;
    const { moved } = turn;
    turn = null;
    preview.classList.remove('turning');
    delete preview.dataset.facingDrag;
    // (a click, not a drag, still makes it wiggle)
    if (moved) {
      preview.dataset.dragged = '1';
      setTimeout(() => delete preview.dataset.dragged, 0);
    }
    setTurn(0);
  };
  preview.addEventListener('pointerup', letGo);
  preview.addEventListener('pointercancel', letGo);
  const ON_ITS_BACK = ['cape', 'wings', 'batwings', 'surfboard', 'backpack'];
  function peekBack() {
    clearTimeout(backTimer);
    setTurn(Math.PI - 0.001);
    backTimer = setTimeout(() => setTurn(0), 2600);
  }

  // a change to the build (Undo can take it back)
  function setKit(patch, { color } = {}) {
    kitHistory.push({ kit: { ...draft.kit }, color: draft.color, accessory: draft.accessory });
    if (kitHistory.length > 50) kitHistory.shift();
    update({ kit: { ...draft.kit, ...patch }, ...(color ? { color } : {}) });
  }
  function applyPreset(key) {
    const [, parts, color] = KIT_PRESETS[key];
    // (a preset is a new robot; it keeps what it's wearing)
    const wear = Object.fromEntries(Object.keys(WEAR_SLOTS).map((s) => [s, draft.kit[s] || 'none']));
    setKit({ ...KIT_DEFAULT, ...parts, ...wear, cloth: draft.kit.cloth, hair: draft.kit.hair }, { color });
  }
  const any = (list) => list[Math.floor(Math.random() * list.length)];
  $('#kit-random').addEventListener('click', () => {
    const kit = {};
    for (const [slot, [, parts]] of Object.entries(KIT_SLOTS)) kit[slot] = any(Object.keys(parts));
    kit.second = any(KIT_COLOURS);
    kit.accent = any(KIT_COLOURS.filter((c) => c !== kit.second));
    kit.eye = Math.random() < 0.5 ? '' : any(['#7ff3ff', '#7bed9f', '#ff9ecf', '#ffd34d', '#c4a8ff']);
    // (and now and then an outfit too)
    if (Math.random() < 0.4) for (const [slot, [, parts]] of Object.entries(WEAR_SLOTS)) kit[slot] = Math.random() < 0.6 ? any(Object.keys(parts)) : 'none';
    setKit(kit, { color: any(COLORS) });
    wiggle('spin');
  });
  $('#kit-undo').addEventListener('click', () => {
    const last = kitHistory.pop();
    if (last) update({ kit: last.kit, color: last.color, ...(last.accessory ? { accessory: last.accessory } : {}) });
  });

  function wiggle(cls = 'squish') {
    const r = $('#preview');
    r.classList.remove(cls);
    void r.offsetWidth;
    r.classList.add(cls);
  }

  function select(id) {
    showSettings(false);
    if (!id) showPane('look'); // (a new robot: name and folder at the top, then how it looks)
    selected = id;
    const c = state.characters.find((x) => x.id === id);
    draft = c
      ? { name: c.name, folder: c.folder, personality: c.personality, color: c.color, accessory: c.accessory || 'none', body: 'kit', kit: { ...KIT_DEFAULT, ...(c.kit || {}) }, theme: c.theme || 'classic', size: c.size || 'normal', permissionMode: c.permissionMode, model: c.model || '', clickOpens: c.clickOpens || 'chat', wanders: c.wanders !== false }
      : blankDraft();
    $('#form-error').textContent = '';
    renderList();
    renderEditor();
    wiggle('hop');
  }

  async function refresh() {
    state = await cbot.invoke('mgr:state');
    if (selected && !state.characters.some((c) => c.id === selected)) selected = null;
    if (!draft) draft = blankDraft();
    renderList();
    renderSettings();
    // keep in-progress edits; only refresh the bits that come from the robot
    if (selected) {
      const c = state.characters.find((x) => x.id === selected);
      $('#toggle-visible').textContent = c.visible ? 'Put away' : 'Put on desktop';
      $('#editor-title').textContent = `Tuning up ${c.name}`;
    }
  }

  $('#f-name').addEventListener('input', (e) => {
    draft.name = e.target.value;
    renderPreview();
  });
  $('#f-permission').addEventListener('change', (e) => update({ permissionMode: e.target.value }));
  $('#f-model').addEventListener('change', (e) => update({ model: e.target.value }));
  $('#pick-folder').addEventListener('click', async () => {
    const folder = await cbot.invoke('mgr:pick-folder', draft.folder);
    if (folder) update({ folder });
  });
  $('#preview').addEventListener('click', () => $('#preview').dataset.dragged || wiggle(Math.random() < 0.5 ? 'squish' : 'spin'));
  $('#new-robot').addEventListener('click', () => select(null));
  $('#sounds').addEventListener('change', (e) => cbot.invoke('mgr:settings', { sounds: e.target.value }));
  $('#theme').addEventListener('change', (e) => cbot.invoke('mgr:settings', { theme: e.target.value }));
  $('#theme-mode').addEventListener('change', (e) => cbot.invoke('mgr:settings', { themeMode: e.target.value }));

  $('#editor').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!draft.name.trim()) return $('#f-name').focus(), ($('#form-error').textContent = 'Every robot deserves a name.');
    if (!draft.folder) return $('#pick-folder').focus(), ($('#form-error').textContent = 'Pick a home folder so the robot knows where to work.');
    if (selected) {
      await cbot.invoke('mgr:update', selected, draft);
      $('#stage-speech').textContent = 'Ooh, I feel brand new!';
    } else {
      const c = await cbot.invoke('mgr:create', draft);
      selected = c.id;
      await refresh();
      renderEditor();
      $('#stage-speech').textContent = `${draft.name} is on your desktop! Click me there to wake me up.`;
    }
    wiggle('hop');
  });

  $('#toggle-visible').addEventListener('click', () => {
    const c = state.characters.find((x) => x.id === selected);
    if (c) cbot.invoke('mgr:visible', c.id, !c.visible);
  });
  $('#forget').addEventListener('click', async () => {
    if (!confirm(`Wipe ${draft.name}'s memory of your conversation?`)) return;
    await cbot.invoke('mgr:reset', selected);
    $('#stage-speech').textContent = 'Wait… who am I? Where am I?';
    wiggle('spin');
  });
  // delete a robot (asks first; its folder and files are left alone)
  async function deleteRobot(id, name) {
    if (!confirm(`Delete ${name}? It's gone for good. Its folder, its files and its Claude Code conversations are not touched.`)) return;
    await cbot.invoke('mgr:delete', id);
    if (id === selected) {
      selected = null;
      draft = blankDraft();
    }
    await refresh();
    renderEditor();
  }
  $('#delete').addEventListener('click', () => deleteRobot(selected, draft.name));

  cbot.on('mgr:changed', refresh);
  cbot.on('mgr:focus', (id) => select(id === 'new' ? null : id));

  (async () => {
    await refresh();
    const focus = new URLSearchParams(location.search).get('focus');
    if (focus && focus !== 'new' && state.characters.some((c) => c.id === focus)) select(focus);
    else if (!focus && state.characters.length) select(state.characters[0].id);
    else select(null);
  })();
})();
