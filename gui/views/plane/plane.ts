// The flying paper plane (main plane.js moves the window along its arc and says which way
// it's heading): tilt it along its path, mirrored when it flies right to left.
import { showView } from '@/ui/view';
import markup from './plane.html?raw';
import './plane.css';
import * as ipc from '@/ipc';

showView(markup, { title: 'Paper plane' });

(() => {
  const plane = document.querySelector<SVGSVGElement>('#plane')!;
  ipc.on('plane:pose', ({ angle = 0, flip = false, landed = false, fade = false }) => {
    if (fade) return plane.classList.add('fade');
    plane.classList.toggle('landed', landed);
    // (drawn nose-right: flying left it's mirrored, and its tilt with it)
    const a = flip ? Math.PI - angle : angle;
    plane.style.transform = `${flip ? 'scaleX(-1) ' : ''}rotate(${landed ? 0 : a}rad)`;
  });
})();
