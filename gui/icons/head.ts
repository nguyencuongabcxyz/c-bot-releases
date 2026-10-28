// A flat little robot head in its paint (currentColor), 40×40: the robot island's faces, and
// a robot's face in its chat's title bar on the stage.
export const HEAD =
  '<line x1="20" y1="4" x2="20" y2="10" stroke="currentColor" stroke-width="2"/><circle cx="20" cy="4" r="2.6" fill="currentColor"/>' +
  '<rect x="2" y="18" width="4" height="9" rx="2" fill="currentColor"/><rect x="34" y="18" width="4" height="9" rx="2" fill="currentColor"/>' +
  '<rect x="5" y="10" width="30" height="25" rx="8" fill="currentColor"/><rect x="9" y="15" width="22" height="14" rx="6" fill="#0e1424"/>';
export const EYES_OPEN =
  '<circle cx="15" cy="22" r="2.6" fill="#7df9ff"/><circle cx="25" cy="22" r="2.6" fill="#7df9ff"/>';
export const EYES_SHUT =
  '<path d="M12.5 22 q2.5 2 5 0 M22.5 22 q2.5 2 5 0" stroke="#7df9ff" stroke-width="1.6" fill="none" stroke-linecap="round"/>';

/** The head as an <svg> (asleep: its eyes shut). */
export const headSvg = (asleep = false) =>
  `<svg viewBox="0 0 40 40" aria-hidden="true">${HEAD}${asleep ? EYES_SHUT : EYES_OPEN}</svg>`;
