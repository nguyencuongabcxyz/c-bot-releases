// Times as the pages show them.

/** The time of day, as the system writes it: "09:41", "9:41 AM". */
export const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** How long ago, in a few words: "just now", "5 min ago", "yesterday", then the date. */
export function ago(ms: number, now = Date.now()) {
  const s = (now - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 2 * 86400) return 'yesterday';
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} days ago`;
  return new Date(ms).toLocaleDateString();
}
