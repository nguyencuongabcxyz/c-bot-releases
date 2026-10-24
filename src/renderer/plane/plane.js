/* global cbot */
// The flying paper plane (main plane.js moves the window along its arc and says which way
// it's heading): tilt it along its path, mirrored when it flies right to left.
(() => {
  const plane = document.querySelector('#plane');
  cbot.on('plane:pose', ({ angle = 0, flip = false, landed = false, fade = false }) => {
    if (fade) return plane.classList.add('fade');
    plane.classList.toggle('landed', landed);
    // (drawn nose-right: flying left it's mirrored, and its tilt with it)
    const a = flip ? Math.PI - angle : angle;
    plane.style.transform = `${flip ? 'scaleX(-1) ' : ''}rotate(${landed ? 0 : a}rad)`;
  });
})();
