// Times as the pages show them.

/** The time of day, as the system writes it: "09:41", "9:41 AM". */
export const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
