// Tiny synthesized robot noises — no audio files needed.
window.Sfx = (() => {
  let ctx = null;
  let muted = false;
  let lastChirp = 0;

  function audio() {
    if (!ctx) ctx = new AudioContext();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function tone(freq, { at = 0, dur = 0.08, type = 'square', vol = 0.05, to = null } = {}) {
    if (muted) return;
    const a = audio();
    const t = a.currentTime + at;
    const osc = a.createOscillator();
    const gain = a.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (to) osc.frequency.exponentialRampToValueAtTime(to, t + dur);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(a.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  // a burst of filtered noise (a swish)
  function noise({ at = 0, dur = 0.06, vol = 0.2, freq = 1800, type = 'bandpass' } = {}) {
    if (muted) return;
    const a = audio();
    const t = a.currentTime + at;
    const buf = a.createBuffer(1, Math.ceil(a.sampleRate * dur), a.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length) ** 2;
    const src = a.createBufferSource();
    src.buffer = buf;
    const filter = a.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    const gain = a.createGain();
    gain.gain.value = vol;
    src.connect(filter).connect(gain).connect(a.destination);
    src.start(t);
  }

  return {
    setMuted(m) { muted = !!m; },
    wake() { [523, 659, 784, 1047].forEach((f, i) => tone(f, { at: i * 0.07, dur: 0.09 })); },
    sleep() { [784, 659, 523, 392].forEach((f, i) => tone(f, { at: i * 0.1, dur: 0.14, type: 'triangle', vol: 0.06 })); },
    poke() { tone(300, { dur: 0.22, type: 'sine', vol: 0.12, to: 900 }); },
    annoyed() { tone(160, { dur: 0.25, type: 'sawtooth', vol: 0.04 }); tone(120, { at: 0.2, dur: 0.3, type: 'sawtooth', vol: 0.04 }); },
    send() { tone(880, { dur: 0.05 }); tone(1320, { at: 0.05, dur: 0.06 }); },
    tool() { tone(1400 + Math.random() * 400, { dur: 0.03, type: 'sine', vol: 0.04 }); },
    // a spin of the mouse wheel: a quick run of soft notches
    wheel() { for (let i = 0; i < 5; i++) noise({ at: i * 0.045, dur: 0.012, vol: 0.12, freq: 3200 - i * 150 }); },
    // R2-style babble while the answer streams in
    chirp() {
      const now = performance.now();
      if (now - lastChirp < 70) return;
      lastChirp = now;
      tone(500 + Math.random() * 900, { dur: 0.045, vol: 0.025 });
    },
    done() { tone(988, { dur: 0.1, type: 'triangle', vol: 0.08 }); tone(1319, { at: 0.1, dur: 0.18, type: 'triangle', vol: 0.08 }); },
    // a curious little "hmm?" for running commentary
    hmm() { tone(392, { dur: 0.12, type: 'triangle', vol: 0.06, to: 330 }); tone(523, { at: 0.13, dur: 0.16, type: 'triangle', vol: 0.06, to: 660 }); },
    // "ooh?" when food appears, "nom nom nom" when it's eaten
    ooh() { tone(330, { dur: 0.25, type: 'sine', vol: 0.08, to: 700 }); },
    chomp() { [0, 0.16, 0.32].forEach((at) => tone(230, { at, dur: 0.09, type: 'square', vol: 0.05, to: 120 })); tone(880, { at: 0.5, dur: 0.12, type: 'triangle', vol: 0.06 }); },
    // "ding-ding?" when Claude asks you something
    ask() { tone(784, { dur: 0.12, type: 'triangle', vol: 0.08 }); tone(1047, { at: 0.14, dur: 0.2, type: 'triangle', vol: 0.08, to: 1175 }); },
    // a pen tick on the to-do list, a brain-swap warble, and the compactor's crunch
    tick() { tone(1568, { dur: 0.05, type: 'triangle', vol: 0.07 }); tone(2093, { at: 0.06, dur: 0.08, type: 'triangle', vol: 0.06 }); },
    swap() { [440, 660, 550, 880].forEach((f, i) => tone(f, { at: i * 0.06, dur: 0.07, type: 'sine', vol: 0.07 })); },
    crunch() { [0, 0.12, 0.24, 0.36].forEach((at, i) => tone(180 - i * 25, { at, dur: 0.1, type: 'sawtooth', vol: 0.035, to: 90 })); },
    // the hammer's swing: a short airy whoosh
    swish() {
      noise({ dur: 0.1, vol: 0.05, freq: 700 });
    },
    // a squeaky toy hammer: a hollow bonk with the squeak-squeak of the bellows
    squeak() {
      tone(220, { dur: 0.08, type: 'sine', vol: 0.12, to: 110 });
      tone(1500, { at: 0.02, dur: 0.07, type: 'triangle', vol: 0.09, to: 2300 });
      tone(2300, { at: 0.09, dur: 0.11, type: 'triangle', vol: 0.08, to: 1300 });
    },
    oops() { tone(440, { dur: 0.18, type: 'square', vol: 0.04, to: 160 }); },
    whee() { tone(400, { dur: 0.35, type: 'sine', vol: 0.08, to: 1200 }); },
    // idle antics, kept quiet: a hummed little tune, a sneeze, a big snore, a snot bubble popping, a boing
    hum() { [523, 587, 659, 587, 523].forEach((f, i) => tone(f, { at: i * 0.22, dur: 0.2, type: 'sine', vol: 0.035 })); },
    sneeze() { noise({ dur: 0.22, vol: 0.06, freq: 2600 }); tone(700, { dur: 0.16, type: 'triangle', vol: 0.04, to: 300 }); },
    snore() { noise({ dur: 0.45, vol: 0.05, freq: 220, type: 'lowpass' }); tone(90, { dur: 0.45, type: 'sawtooth', vol: 0.02, to: 70 }); },
    pop() { tone(900, { dur: 0.05, type: 'sine', vol: 0.06, to: 1800 }); },
    // the standing desk: its panel's beep, the motor's hum (rising pitch going up), the chair's gas lift
    beep() { tone(1760, { dur: 0.07, type: 'square', vol: 0.03 }); },
    motor(up = true) { tone(up ? 95 : 120, { dur: 2.8, type: 'sawtooth', vol: 0.018, to: up ? 120 : 95 }); tone(190, { dur: 2.8, type: 'triangle', vol: 0.012 }); },
    hiss() { noise({ dur: 0.9, vol: 0.05, freq: 5000, type: 'highpass' }); },
    // bubble tea through a fat straw: a gurgly slurp with a pearl going "thup"
    slurp() { [0, 0.09, 0.2, 0.31].forEach((at) => noise({ at, dur: 0.08, vol: 0.09, freq: 700 })); tone(260, { at: 0.42, dur: 0.06, type: 'sine', vol: 0.07, to: 520 }); },
    // straining at the third rep: a low, wobbly "hnnngh"
    grunt() { tone(150, { dur: 0.5, type: 'sawtooth', vol: 0.025, to: 120 }); tone(156, { dur: 0.5, type: 'sawtooth', vol: 0.02, to: 128 }); },
    // IT-office antics: a yanked cable's thunk, a keyboard full of crumbs, payday's ka-ching, a blue-screen crash
    thunk() { tone(110, { dur: 0.18, type: 'sine', vol: 0.12, to: 60 }); noise({ dur: 0.08, vol: 0.05, freq: 300, type: 'lowpass' }); },
    rattle() { for (let i = 0; i < 9; i++) noise({ at: i * 0.11 + Math.random() * 0.04, dur: 0.03, vol: 0.05, freq: 3200 }); },
    kaching() { tone(1568, { dur: 0.08, type: 'square', vol: 0.03 }); tone(2093, { at: 0.08, dur: 0.25, type: 'triangle', vol: 0.06 }); noise({ at: 0.05, dur: 0.15, vol: 0.03, freq: 5000 }); },
    crash() { [523, 392, 311, 196].forEach((f, i) => tone(f, { at: i * 0.12, dur: 0.16, type: 'square', vol: 0.04 })); noise({ at: 0.5, dur: 0.25, vol: 0.05, freq: 900 }); },
    // sleep antics: waking from a nightmare with a gasp, a phone buzzing on the desk, a robot vacuum's hum
    gasp() { noise({ dur: 0.35, vol: 0.06, freq: 2400, type: 'highpass' }); tone(500, { dur: 0.3, type: 'sine', vol: 0.05, to: 900 }); },
    buzz() { tone(140, { dur: 0.35, type: 'sawtooth', vol: 0.03 }); tone(146, { dur: 0.35, type: 'square', vol: 0.015 }); },
    vacuum() { noise({ dur: 1.6, vol: 0.025, freq: 500, type: 'lowpass' }); tone(220, { dur: 1.6, type: 'sine', vol: 0.012 }); },
    boing() { tone(180, { dur: 0.4, type: 'sine', vol: 0.06, to: 520 }); },
    // hover-menu interactions
    charge() {
      // a rising hum, then a bright "full!" ding
      tone(180, { dur: 1.8, type: 'sawtooth', vol: 0.02, to: 900 });
      [523, 659, 784, 1047].forEach((f, i) => tone(f, { at: 1.9 + i * 0.07, dur: 0.12, type: 'triangle', vol: 0.06 }));
    },
    giggle() {
      [0, 0.13, 0.26, 0.39, 0.52, 0.68].forEach((at, i) => tone(880 + (i % 2) * 220 - i * 40, { at, dur: 0.09, type: 'triangle', vol: 0.05, to: 700 }));
    },
    clap() {
      noise({ dur: 0.09, vol: 0.45, freq: 2400 });
      noise({ at: 0.012, dur: 0.07, vol: 0.25, freq: 1200 });
      tone(1568, { at: 0.08, dur: 0.12, type: 'triangle', vol: 0.05 });
    },
    // a little disco loop, about four seconds
    dance() {
      const bass = [131, 131, 196, 196, 165, 165, 196, 220];
      const tune = [523, 659, 784, 659, 587, 698, 880, 784];
      for (let bar = 0; bar < 2; bar++) {
        bass.forEach((f, i) => tone(f, { at: bar * 2 + i * 0.25, dur: 0.18, type: 'square', vol: 0.025 }));
        tune.forEach((f, i) => tone(f, { at: bar * 2 + i * 0.25 + 0.12, dur: 0.12, type: 'triangle', vol: 0.04 }));
        for (let i = 0; i < 8; i++) noise({ at: bar * 2 + i * 0.25, dur: 0.04, vol: 0.05, freq: i % 2 ? 6000 : 300, type: i % 2 ? 'highpass' : 'lowpass' });
      }
    },
  };
})();
