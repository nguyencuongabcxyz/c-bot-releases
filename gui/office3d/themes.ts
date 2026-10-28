import { roundRect } from './materials';

// Desk themes: the colours of the workstation (desk, chair, monitor, props),
// what the monitor shows, and the robot's accents (badge, lanyard, status
// light). A theme can also bring brand touches: a logo for the monitor, the
// badge, a desk nameplate, the mug and the back of the chair.
//
// theme = {
//   label,
//   desk: { top, frame, handle }, chair: { seat, frame, wheel }, monitor: { bezel, stand },
//   keyboard: { body, keys }, mug: { body, band }, lamp: { shade, base },
//   screen: { accent, scenes: { name: (ctx, t, accent) => draw } } | null,
//   brand: { name, short, tagline, plate, ink, accent, font, logo(ctx, x, y, width, onDark) } | null,
//   robot: { light, lanyard, badge },   // status light, lanyard, badge header colour
//   paint,                              // the paint job that goes with it
// }

/** A monitor scene (screens.ts drawScreen): drawn on the 320x200 screen at `t` seconds in. */
export type ScreenScene = (
  ctx: CanvasRenderingContext2D,
  t: number,
  accent: string,
  theme?: Theme,
  text?: string,
) => void;
/** A company's look: its logo is `width` px wide, top-left at (x, y); onDark: on a dark background. */
export type Brand = {
  name: string;
  short: string;
  tagline?: string;
  plate?: string;
  ink?: string;
  accent?: string;
  font?: string;
  logo: (ctx: CanvasRenderingContext2D, x: number, y: number, width: number, onDark?: boolean) => void;
};
export type Theme = {
  label: string;
  desk: { top: string; frame: string; handle: string; column?: string };
  chair: { seat: string; frame: string; wheel: string };
  monitor: { bezel: string; stand: string };
  keyboard: { body: string; keys: string };
  mug: { body: string; band: string };
  lamp: { shade: string; base: string };
  screen: { accent: string; scenes: Record<string, ScreenScene> } | null;
  brand: Brand | null;
  robot: { light: string; lanyard: string; badge: string | null };
  paint: string | null;
};

// ---------------------------------------------------------------- Sioux Connect

// The Sioux Connect tent mark (sx-connect-portal/src/assets/header-logo.svg, 63x40):
// three peaks with orange pennants and an orange tent door.
const SIOUX_ORANGE = '#F47920';
const SIOUX_INK = '#484848';
const SIOUX_LOGO: [string, string][] = [
  [
    '#F47920',
    'M45.5122 15.3808V9.77127H46.2413C46.8887 10.5651 48.6126 11.1127 51.5882 11.374C51.668 11.4693 51.7463 11.6812 51.5867 11.7818C51.1611 12.05 50.4215 12.2652 49.5223 12.4043L51.3985 12.7523C51.63 12.8468 51.6889 12.9566 51.4667 13.0912C50.2657 13.8711 48.499 13.9356 46.1198 14.007V15.3808H45.5122V15.3808Z',
  ],
  [
    'ink',
    'M28.753 38.7349C32.5532 36.4184 36.0325 33.2988 39.5845 27.3282C43.4512 20.023 44.3071 18.2354 45.0604 16.6581C45.3989 16.0625 46.2797 16.1585 46.5301 16.7085C49.6632 23.5905 53.5081 30.4968 56.7137 34.0672C59.0509 36.2108 61.1043 37.609 62.7785 38.7349C63.0854 38.9413 63.0014 39.1024 62.8107 39.1135C57.7151 39.4101 53.0457 38.9158 47.8316 38.6204C47.6877 38.5328 47.5054 38.573 47.4001 38.2432C46.5787 35.6702 46.206 33.4984 45.7657 30.3778C45.4041 33.3533 44.7758 35.896 43.9516 38.1525C43.9081 38.2718 43.8659 38.4627 43.5784 38.5059C41.9953 38.744 42.015 38.8613 35.5672 39.124C32.9613 39.1873 30.3244 39.2546 28.6725 39.1176C28.4924 39.1026 28.4431 38.9238 28.753 38.7349ZM45.7513 21.5917C45.6702 28.9085 48.5238 34.2205 51.3556 36.5598C53.2226 37.5022 54.9755 37.95 57.9177 37.8191C53.514 34.6469 49.5649 27.5605 45.7553 19.2732C42.1803 27.4526 38.3311 34.2319 33.8568 37.8191C36.751 37.87 38.8889 37.527 40.2974 36.5598C43.9828 32.9573 45.6375 28.0265 45.7513 21.5917C45.7523 21.5061 45.7536 21.4201 45.7553 21.3338C45.7542 21.4201 45.7529 21.5061 45.7513 21.5917Z',
  ],
  [
    '#F47920',
    'M16.9834 15.3808V9.77127H17.7125C18.3599 10.5651 20.0838 11.1127 23.0594 11.374C23.1392 11.4693 23.2175 11.6812 23.0579 11.7818C22.6323 12.05 21.8927 12.2652 20.9935 12.4043L22.8697 12.7523C23.1012 12.8468 23.1601 12.9566 22.9378 13.0912C21.7369 13.8711 19.9701 13.9356 17.591 14.007V15.3808H16.9834V15.3808Z',
  ],
  [
    'ink',
    'M0.224187 38.7349C4.02442 36.4184 7.5037 33.2988 11.0557 27.3282C14.9224 20.023 15.7783 18.2354 16.5316 16.6581C16.8701 16.0625 17.7509 16.1585 18.0013 16.7085C21.1344 23.5905 24.9793 30.4968 28.1849 34.0672C30.5221 36.2108 32.5755 37.609 34.2497 38.7349C34.5566 38.9413 34.4725 39.1024 34.2819 39.1135C29.1863 39.4101 24.5168 38.9158 19.3028 38.6204C19.1588 38.5328 18.9765 38.573 18.8713 38.2432C18.0499 35.6702 17.6771 33.4984 17.2369 30.3778C16.8753 33.3533 16.247 35.896 15.4228 38.1525C15.3793 38.2718 15.337 38.4627 15.0496 38.5059C13.4665 38.744 13.4862 38.8613 7.03843 39.124C4.43246 39.1873 1.79564 39.2546 0.143726 39.1176C-0.0363959 39.1026 -0.0857453 38.9238 0.224187 38.7349ZM17.2225 21.5917C17.1414 28.9085 19.995 34.2205 22.8268 36.5598C24.6938 37.5022 26.4467 37.95 29.3889 37.8191C24.9851 34.6469 21.0361 27.5605 17.2265 19.2732C13.6515 27.4526 9.80233 34.2319 5.32804 37.8191C8.22223 37.87 10.3601 37.527 11.7686 36.5598C15.454 32.9573 17.1087 28.0265 17.2226 21.5917C17.2235 21.5061 17.2248 21.4201 17.2265 21.3338C17.2254 21.4201 17.2241 21.5061 17.2226 21.5917H17.2225Z',
  ],
  ['paper', 'M40.4303 22.392C44.0798 29.0958 50.0007 35.2592 57.5309 40L25.7534 39.817L40.4303 22.392Z'],
  ['paper', 'M22.2856 22.392C18.6361 29.0958 12.7152 35.2592 5.18506 40L36.9625 39.817L22.2856 22.392Z'],
  [
    '#F47920',
    'M31.1514 7.4718V0H32.0762C32.8974 1.05738 35.0841 1.78679 38.8583 2.13478C38.9596 2.26167 39.059 2.54393 38.8565 2.67791C38.3166 3.03513 37.3786 3.32183 36.2379 3.50715L38.6177 3.97065C38.9114 4.09658 38.9861 4.24278 38.7042 4.42207C37.1809 5.46086 34.9398 5.54682 31.9221 5.64194V7.47177H31.1514V7.4718Z',
  ],
  [
    '#F47920',
    'M31.4595 17.3468C31.8268 24.7937 38.1574 34.6131 45.1379 37.4748L35.4826 36.3404L31.4595 24.7758V17.3468Z',
  ],
  [
    '#F47920',
    'M31.4594 17.3468C30.6754 26.1216 24.5619 35.1295 17.6699 37.4748L27.4362 36.3404L31.4594 24.7758V17.3468Z',
  ],
  [
    'ink',
    'M9.89329 38.5788C14.7137 35.4934 19.1269 31.338 23.6323 23.3854C28.537 13.6551 29.6227 11.2741 30.5782 9.1731C31.0076 8.3798 32.1248 8.50759 32.4424 9.24022C36.4165 18.4069 41.2935 27.6059 45.3596 32.3615C48.3242 35.2168 50.9289 37.0792 53.0524 38.5788C53.4417 38.8538 53.3351 39.0684 53.0933 39.0832C46.6298 39.4782 40.7069 38.8198 34.0932 38.4264C33.9107 38.3098 33.6794 38.3631 33.5459 37.924C32.504 34.4967 32.0312 31.6041 31.4728 27.4474C31.0141 31.4107 30.2172 34.7976 29.1717 37.8032C29.1165 37.962 29.063 38.2163 28.6983 38.2739C26.6902 38.591 26.7153 38.7472 18.5367 39.0971C15.2312 39.1815 11.8866 39.2711 9.79119 39.0886C9.56272 39.0687 9.50013 38.8305 9.89326 38.5788H9.89329ZM31.4546 15.7446C31.3517 25.4903 34.9713 32.5657 38.5633 35.6816C40.9314 36.9369 43.1548 37.5333 46.8868 37.3589C41.301 33.1337 36.2918 23.6948 31.4596 12.6563C26.925 23.5511 22.0426 32.5809 16.3672 37.3589C20.0383 37.4268 22.75 36.9699 24.5366 35.6816C29.2113 30.8832 31.3103 24.3155 31.4546 15.7446C31.4558 15.6305 31.4574 15.516 31.4595 15.4011C31.4582 15.5159 31.4565 15.6304 31.4546 15.7446Z',
  ],
];
let siouxPaths: [string, Path2D][] | null = null;

/** The tent mark, `width` px wide, top-left at (x, y). On dark backgrounds the grey outlines turn white. */
function siouxLogo(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, onDark = false) {
  siouxPaths ||= SIOUX_LOGO.map(([fill, d]) => [fill, new Path2D(d)]);
  const k = width / 63;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(k, k);
  for (const [fill, path] of siouxPaths) {
    ctx.fillStyle =
      fill === 'ink'
        ? onDark
          ? '#ffffff'
          : SIOUX_INK
        : fill === 'paper'
          ? onDark
            ? 'rgba(255,255,255,0.12)'
            : '#ffffff'
          : fill;
    ctx.fill(path, 'evenodd');
  }
  ctx.restore();
}

// the "SIOUX CONNECT" wordmark (Koulen in the app; the nearest condensed face Windows has)
const WORDMARK_FONT = '"Koulen", "Bahnschrift SemiBold Condensed", "Bahnschrift", Impact, "Arial Narrow", sans-serif';
function siouxWordmark(ctx: CanvasRenderingContext2D, cx: number, y: number, size: number, onDark = false) {
  ctx.save();
  ctx.font = `${size}px ${WORDMARK_FONT}`;
  ctx.textBaseline = 'alphabetic';
  const a = 'SIOUX ';
  const b = 'CONNECT';
  const wa = ctx.measureText(a).width;
  const wb = ctx.measureText(b).width;
  const x = cx - (wa + wb) / 2;
  ctx.textAlign = 'left';
  ctx.fillStyle = onDark ? '#ffffff' : SIOUX_INK;
  ctx.fillText(a, x, y);
  ctx.fillStyle = onDark ? '#33271e' : SIOUX_ORANGE; // on the orange splash: the brand's title-on-orange tint
  ctx.fillText(b, x + wa, y);
  ctx.restore();
}

// the app's own backdrop: pale blue, grey, pale peach (AppShell.tsx)
function siouxBackdrop(ctx: CanvasRenderingContext2D) {
  const g = ctx.createLinearGradient(320, 200, 0, 0);
  g.addColorStop(0, '#E7F9FF');
  g.addColorStop(0.23, '#F8F8F8');
  g.addColorStop(0.8, '#F8F8F8');
  g.addColorStop(1, '#FFF2E8');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 320, 200);
}

const SIOUX_SCENES: Record<string, ScreenScene> = {
  // waiting for a question: the portal's home, logo and wordmark, a blinking prompt
  idle(ctx, t) {
    siouxBackdrop(ctx);
    const bob = Math.sin(t * 1.6) * 2;
    siouxLogo(ctx, 160 - 63, 34 + bob, 126);
    siouxWordmark(ctx, 160, 150, 34);
    ctx.fillStyle = SIOUX_ORANGE;
    ctx.font = '700 18px Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.fillText('>', 16, 186);
    if (Math.floor(t * 2) % 2 === 0) ctx.fillRect(32, 172, 9, 17);
  },
  // starting up: an orange splash, like the login panel
  boot(ctx, t) {
    ctx.fillStyle = SIOUX_ORANGE;
    ctx.fillRect(0, 0, 320, 200);
    siouxLogo(ctx, 160 - 50, 30, 100, true);
    siouxWordmark(ctx, 160, 132, 28, true);
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    roundRect(ctx, 90, 152, 140, 10, 5);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    roundRect(ctx, 90, 152, 140 * Math.min(1, t / 0.9), 10, 5);
    ctx.fill();
  },
};

// ---------------------------------------------------------------- the themes

export const THEMES: Record<string, Theme> = {
  classic: {
    label: 'Classic',
    desk: { top: '#f0c48c', frame: '#c98f58', handle: '#1d2235' },
    chair: { seat: '#4b5272', frame: '#3a4060', wheel: '#1d2235' },
    monitor: { bezel: '#2a3049', stand: '#8a90a6' },
    keyboard: { body: '#e8ebf5', keys: '#b9bfd3' },
    mug: { body: '#ffffff', band: '#e5484d' },
    lamp: { shade: '#ffd34d', base: '#ffd34d' },
    screen: null,
    brand: null,
    robot: { light: '#ff5e62', lanyard: '#2b6fe0', badge: null },
    paint: null,
  },
  sioux: {
    label: 'Sioux Connect',
    desk: { top: '#f4eee9', frame: SIOUX_INK, handle: SIOUX_ORANGE },
    chair: { seat: '#5c5c5c', frame: SIOUX_INK, wheel: '#2e2e2e' },
    monitor: { bezel: SIOUX_INK, stand: '#cbcbcb' },
    keyboard: { body: '#ffffff', keys: '#cbcbcb' },
    mug: { body: '#ffffff', band: SIOUX_ORANGE },
    lamp: { shade: '#00AEEF', base: SIOUX_INK },
    screen: { accent: SIOUX_ORANGE, scenes: SIOUX_SCENES },
    brand: {
      name: 'Sioux Connect',
      short: 'Sioux Connect',
      tagline: 'Employee portal',
      plate: '#ffffff',
      ink: SIOUX_INK,
      accent: SIOUX_ORANGE,
      font: '"Space Grotesk", "Segoe UI", sans-serif',
      logo: siouxLogo,
    },
    robot: { light: SIOUX_ORANGE, lanyard: '#00AEEF', badge: SIOUX_ORANGE },
    paint: SIOUX_ORANGE,
  },
};

export const themeOf = (key: string) => THEMES[key] || THEMES.classic;
