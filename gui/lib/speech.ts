// Reading English words and sentences aloud (the word card, My words).

/** Say it with an English voice: a natural Windows one if there is one. Whatever was being said stops. */
export function sayInEnglish(text: string | undefined) {
  if (!text || !window.speechSynthesis) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const voices = speechSynthesis.getVoices();
  u.voice =
    voices.find((v) => v.lang === 'en-US' && /natural|aria|jenny|guy/i.test(v.name)) ||
    voices.find((v) => v.lang === 'en-US') ||
    voices.find((v) => v.lang.startsWith('en')) ||
    null;
  u.lang = 'en-US';
  u.rate = 0.9;
  speechSynthesis.speak(u);
}
