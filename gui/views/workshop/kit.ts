// The robot builder's parts (office3d/kit3d.ts builds them, kitwear.ts dresses them): each
// slot and its parts, the defaults, the themed looks and presets, the colours to pick from.
import type { Kit } from '@/types/model';

// ---- the robot builder (office3d/kit3d.js builds it; these are its parts)
export type Parts = Record<string, string>; // part -> its name
export const KIT_SLOTS: Record<string, [string, Parts]> = {
  head: [
    'Head',
    { box: 'Rounded box', ball: 'Ball', dome: 'Dome', capsule: 'Capsule', tv: 'Old TV', bucket: 'Bucket' },
  ],
  face: ['Face', { dots: 'Classic', cute: 'Cute', visor: 'Visor', cyclops: 'Cyclops', pixel: 'Pixel' }],
  top: [
    'On top',
    {
      antenna: 'Antenna',
      twin: 'Twin antennas',
      ears: 'Cat ears',
      propeller: 'Propeller',
      dish: 'Dish',
      bulb: 'Light bulb',
      pigtails: 'Pigtails',
      ponytail: 'Ponytail',
      spiky: 'Spiky hair',
      curly: 'Curly hair',
      none: 'Nothing',
    },
  ],
  body: ['Body', { box: 'Box', barrel: 'Barrel', egg: 'Egg', slim: 'Slim', chunky: 'Chunky' }],
  arms: ['Arms', { classic: 'Classic', noodle: 'Noodle', mitten: 'Mittens', claw: 'Claws' }],
  base: ['Stands on', { legs: 'Legs', wheel: 'A wheel', treads: 'Treads', hover: 'A jet', spring: 'A spring' }],
  finish: ['Finish', { matte: 'Matte', glossy: 'Glossy', metal: 'Metal', wood: 'Painted wood' }],
};
export const KIT_DEFAULT: Required<Kit> = {
  head: 'box',
  face: 'dots',
  top: 'antenna',
  body: 'box',
  arms: 'classic',
  base: 'legs',
  finish: 'matte',
  clothes: 'none',
  neck: 'none',
  extra: 'none',
  specs: 'none',
  second: '#8a90a6',
  accent: '#ff5e62',
  eye: '',
  cloth: '#4a90e2',
  hair: '#5a3a22',
};
// what it wears (office3d/kitwear.js), in the Outfit tab
export type WearSlot = 'clothes' | 'neck' | 'extra' | 'specs';
export const WEAR_SLOTS: Record<WearSlot, [string, Parts]> = {
  clothes: [
    'Clothes',
    {
      none: 'Nothing',
      tshirt: 'T-shirt',
      hawaiian: 'Hawaiian shirt',
      suit: 'Suit',
      santa: 'Santa suit',
      elf: 'Elf tunic',
      vampire: 'Vampire',
      witch: 'Witch dress',
      dress: 'Dress',
      swimsuit: 'Swimsuit',
      tutu: 'Tutu',
      maid: 'Maid dress',
    },
  ],
  neck: [
    'Round its neck',
    { none: 'Nothing', scarf: 'Scarf', tie: 'Tie', bow: 'Bow', pearls: 'Pearls', lei: 'Flower lei' },
  ],
  extra: [
    'Holding, or on its back',
    {
      none: 'Nothing',
      gift: 'A present',
      candycane: 'Candy cane',
      pumpkin: 'Pumpkin bucket',
      icecream: 'Ice cream',
      balloon: 'Balloon',
      cape: 'Cape',
      wings: 'Fairy wings',
      batwings: 'Bat wings',
      surfboard: 'Surfboard',
      backpack: 'Backpack',
      duster: 'Feather duster',
    },
  ],
  specs: [
    'Glasses',
    {
      none: 'Nothing',
      sunglasses: 'Sunglasses',
      heart: 'Heart shades',
      round: 'Round glasses',
      star: 'Star glasses',
      eyepatch: 'Eye patch',
    },
  ],
};
// themed looks: a hat (the Accessory) and what it wears, for a boy and a girl
export const GIRL_HAIR = ['pigtails', 'ponytail', 'curly'];
export type Look = Kit & { accessory?: string };
export const LOOKS: [string, [string, 'boy' | 'girl', Look][]][] = [
  [
    'Christmas',
    [
      ['Santa', 'boy', { accessory: 'santa', clothes: 'santa', neck: 'none', extra: 'gift', specs: 'none' }],
      [
        'Elf',
        'girl',
        { accessory: 'elf', clothes: 'elf', neck: 'bow', extra: 'candycane', specs: 'none', top: 'pigtails' },
      ],
    ],
  ],
  [
    'Halloween',
    [
      ['Vampire', 'boy', { accessory: 'none', clothes: 'vampire', neck: 'none', extra: 'cape', specs: 'none' }],
      [
        'Witch',
        'girl',
        { accessory: 'witch', clothes: 'witch', neck: 'none', extra: 'pumpkin', specs: 'none', top: 'ponytail' },
      ],
    ],
  ],
  [
    'Beach',
    [
      [
        'Surfer',
        'boy',
        {
          accessory: 'strawhat',
          clothes: 'hawaiian',
          neck: 'lei',
          extra: 'surfboard',
          specs: 'sunglasses',
          cloth: '#36c2d9',
        },
      ],
      [
        'Beach day',
        'girl',
        {
          accessory: 'sunhat',
          clothes: 'swimsuit',
          neck: 'lei',
          extra: 'icecream',
          specs: 'heart',
          cloth: '#ff6fa5',
          top: 'pigtails',
        },
      ],
    ],
  ],
  [
    'Party',
    [
      ['Gentleman', 'boy', { accessory: 'tophat', clothes: 'suit', neck: 'none', extra: 'balloon', specs: 'round' }],
      [
        'Princess',
        'girl',
        {
          accessory: 'tiara',
          clothes: 'dress',
          neck: 'pearls',
          extra: 'wings',
          specs: 'none',
          cloth: '#c77dff',
          top: 'curly',
        },
      ],
    ],
  ],
  [
    'Winter',
    [
      [
        'Snow day',
        'boy',
        { accessory: 'beanie', clothes: 'tshirt', neck: 'scarf', extra: 'backpack', specs: 'none', cloth: '#3a7bd5' },
      ],
      [
        'Snow day',
        'girl',
        {
          accessory: 'hairbow',
          clothes: 'dress',
          neck: 'scarf',
          extra: 'gift',
          specs: 'none',
          cloth: '#a8d8ff',
          top: 'pigtails',
        },
      ],
    ],
  ],
];
export const KIT_PRESETS: Record<string, [string, Kit, string | null]> = {
  classic: ['Classic bot', {}, null],
  cat: [
    'Cat-bot',
    {
      head: 'ball',
      face: 'cute',
      top: 'ears',
      body: 'egg',
      arms: 'mitten',
      finish: 'glossy',
      second: '#f4d7b8',
      accent: '#ff8fb1',
    },
    '#f5a25d',
  ],
  nerd: [
    'Nerd-bot',
    {
      face: 'visor',
      body: 'slim',
      arms: 'claw',
      base: 'treads',
      second: '#5f6b7a',
      accent: '#7bed9f',
      eye: '#7bed9f',
    },
    '#a29bfe',
  ],
  cutie: [
    'Cutie-bot',
    {
      head: 'capsule',
      face: 'cute',
      top: 'bulb',
      body: 'egg',
      arms: 'mitten',
      base: 'hover',
      finish: 'glossy',
      second: '#ffd1e3',
      accent: '#ff8fb1',
      eye: '#ff9ecf',
    },
    '#ff8fb1',
  ],
  rover: [
    'Rover',
    {
      head: 'dome',
      face: 'cyclops',
      top: 'dish',
      body: 'barrel',
      arms: 'claw',
      base: 'wheel',
      finish: 'metal',
      second: '#5f6b7a',
      accent: '#ffb347',
    },
    '#c8d6e5',
  ],
  retro: [
    'Retro TV',
    {
      head: 'tv',
      face: 'pixel',
      top: 'twin',
      arms: 'noodle',
      base: 'spring',
      finish: 'wood',
      second: '#6b4f2a',
      accent: '#ffd34d',
      eye: '#7bed9f',
    },
    '#e2b07a',
  ],
};
export const KIT_COLOURS = [
  '#8a90a6',
  '#5f6b7a',
  '#1d2235',
  '#ffffff',
  '#ff5e62',
  '#ffb347',
  '#ffd34d',
  '#7bed9f',
  '#5ac8fa',
  '#a29bfe',
  '#ff8fb1',
  '#6b4f2a',
];
// (worn on its back: picking one turns the preview round to show it)
export const ON_ITS_BACK = ['cape', 'wings', 'batwings', 'surfboard', 'backpack'];
