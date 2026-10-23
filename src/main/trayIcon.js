const { nativeImage } = require('electron');

// 16x16 pixel-art robot head, drawn at 2x for crisp tray rendering.
// . transparent  a antenna  b body  e eye  m mouth  o outline
const ART = [
  '.......aa.......',
  '.......aa.......',
  '........o.......',
  '...oooooooooo...',
  '..obbbbbbbbbbo..',
  '..obbbbbbbbbbo..',
  '.oobeeebbeeeboo.',
  '.oobeeebbeeeboo.',
  '.oobeeebbeeeboo.',
  '..obbbbbbbbbbo..',
  '..obbbmmmmbbbo..',
  '..obbbbbbbbbbo..',
  '...oooooooooo...',
  '.....obbbbo.....',
  '....oooooooo....',
  '................',
];

const COLORS = {
  a: [255, 94, 98, 255],
  b: [90, 200, 250, 255],
  e: [255, 255, 255, 255],
  m: [30, 40, 60, 255],
  o: [30, 40, 60, 255],
};

function trayIcon() {
  const scale = 2;
  const size = 16 * scale;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const ch = ART[Math.floor(y / scale)][Math.floor(x / scale)];
      const [r, g, b, a] = COLORS[ch] || [0, 0, 0, 0];
      const i = (y * size + x) * 4;
      // nativeImage bitmaps are BGRA
      buf[i] = b;
      buf[i + 1] = g;
      buf[i + 2] = r;
      buf[i + 3] = a;
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: scale });
}

module.exports = { trayIcon };
