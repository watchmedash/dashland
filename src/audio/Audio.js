// Fully procedural audio — no asset files. Noise-shaped impacts for footsteps
// and block interaction, a layered ambient bed, and a slow generative pad.
//
// Buses
// -----
// Everything lands on one of four buses and every bus goes through the same
// master trim, a muffle filter and a compressor:
//
//   sfx  ─┬─────────────────────────┐
//         └─ send → reverb ─────────┤
//   amb  ────────────────────────── ├→ master → muffle → comp → destination
//   ui   ────────────────────────── │
//   music ───┬───────────────────── ┘
//            └─ long reverb ────────┘
//
// The muffle is a lowpass that sits wide open at 20kHz and closes to a few
// hundred Hz underwater — that one node is what makes going under read as being
// under, far more than any level change does.
//
// Voice budget
// ------------
// Every voice-producing call takes a token from `_take()` before it builds
// anything, and returns it on a timer sized to the voice's own length. Costs
// are weighted by how many nodes a category actually builds, so a herd of mobs
// and a landslide of block breaks compete for one budget instead of each having
// their own unbounded one. Over budget, the call returns without building a
// graph; it is never queued, because a late footstep is worse than none.
//
// Positional model
// ----------------
// World-originating sounds (block break/place/dig, mob calls, mob impacts) take
// an optional world position and are routed through a PannerNode. Player-centric
// sounds (own footsteps, hurt, pickup, UI, thunder) stay on the dry bus so they
// never drift with head movement. The listener is driven from the camera every
// frame by `setListener()` — this is a sphere world, so "up" is the player's
// local up, not world +Y.

import { Ambience } from './Ambience.js';

const MATERIAL_TUNING = {
  stone: { lo: 480, hi: 2400, decay: 0.10, tone: 0.20, noise: 1.0, body: 150 },
  soil: { lo: 200, hi: 1100, decay: 0.13, tone: 0.10, noise: 1.0, body: 95 },
  grass: { lo: 900, hi: 5200, decay: 0.09, tone: 0.05, noise: 1.0, body: 0 },
  sand: { lo: 1400, hi: 7000, decay: 0.11, tone: 0.02, noise: 1.0, body: 0 },
  snow: { lo: 600, hi: 3600, decay: 0.13, tone: 0.04, noise: 1.0, body: 0 },
  wood: { lo: 300, hi: 1900, decay: 0.11, tone: 0.42, noise: 0.7, body: 220 },
  glass: { lo: 1800, hi: 9000, decay: 0.16, tone: 0.55, noise: 0.5, body: 1400 },
  metal: { lo: 900, hi: 6000, decay: 0.28, tone: 0.62, noise: 0.4, body: 620 },
  water: { lo: 300, hi: 2600, decay: 0.22, tone: 0.10, noise: 1.0, body: 0 },
};

// Distance law shared by every positional source. Inverse rolloff, so a sound
// at `REF_DISTANCE` plays at full level and falls away as roughly ref/dist
// beyond it: 4/(4 + 1.1*(d-4)) → 1.00 at 4m, 0.28 at 15m, 0.09 at 40m.
const REF_DISTANCE = 4;
const MAX_DISTANCE = 120;
const ROLLOFF = 1.1;

// A second law for sounds meant to be navigated towards rather than merely
// heard. Under the curve above a source is at 9% by 40m and 3% by 120m, which
// is fine for a sheep and useless for a landmark: the merchant's bell was
// inaudible everywhere except where you had already found him. This one holds
// 18m at full and decays gently — 0.38 at 60m, 0.22 at 110m.
const FAR_REF_DISTANCE = 18;
const FAR_ROLLOFF = 0.7;

// Per-species vocal identity. `base` is the fundamental in Hz; the four are
// deliberately an octave-plus apart so they never blur together in a herd.
const MOB_VOICE = {
  // Gains are matched by ear/by meter, not by number: the bleat and cluck lose a
  // lot through their formant filters, the groan almost nothing. Pitches are
  // spread well apart so a mixed group never blurs into one texture.
  //
  // Retuned against a 400Hz-weighted RMS render of every sound in the game,
  // because peak dBFS had been ranking a 62Hz groan level with a 4kHz cluck and
  // the ear is thirty-odd dB less sensitive down there. What that measurement
  // found was the clucks: the parrot at -24.7 and the chick at -25.5 were the
  // two loudest things on the planet, TWELVE dB above an overhead thunderclap
  // (-36.5) and thirty above the player's own footstep (-55.7). One parrot
  // standing beside you was a thousand times the power of your own boots.
  // The targets below put a nearby animal at about -34, which is where the cow,
  // the deer and the fox already sat.
  //
  // The groans are deliberately NOT raised to match. The cow, the koala and the
  // husk read quiet on a weighted meter because they are almost all sub-100Hz
  // energy, but they are simultaneously the highest PEAKS in the game (husk
  // -4.5 dBFS) and there is no headroom left to give them. That gap is the
  // instrument, not a mistake: a husk is meant to be felt before it is heard.
  cow: { kind: 'groan', base: 96, dur: 1.10, gain: 0.38 },
  deer: { kind: 'bleat', base: 210, dur: 0.52, gain: 0.36 },
  bunny: { kind: 'squeak', base: 940, dur: 0.11, gain: 0.45 },
  chick: { kind: 'cluck', base: 620, dur: 0.26, gain: 0.13 },
  parrot: { kind: 'cluck', base: 780, dur: 0.30, gain: 0.11 },
  fox: { kind: 'squeak', base: 430, dur: 0.28, gain: 0.32 },
  koala: { kind: 'groan', base: 132, dur: 0.80, gain: 0.30 },
  penguin: { kind: 'cluck', base: 340, dur: 0.38, gain: 0.26 },
  // Deliberately the lowest and longest thing on the planet — you should hear a
  // husk before the dark gives you any chance of seeing it.
  husk: { kind: 'groan', base: 62, dur: 1.70, gain: 0.42 },
  // The merchant is the only tuned, man-made sound out there — a pair of bells
  // on a pack. Nothing else on the planet rings, so one note through the trees
  // is unambiguous even before you can see what made it.
  // `far` puts it on the landmark distance law and out of the shared idle
  // throttle — a beacon that a passing sheep can mute is not a beacon.
  // 0.34 measured as the single loudest sound in the game (-22.3 weighted, 14dB
  // over thunder). It still wants to be the loudest VOICE — it is the one thing
  // out there worth walking towards — so it lands at about -30, above the herd
  // and under the sky.
  merchant: { kind: 'chime', base: 523, dur: 1.30, gain: 0.135, far: true },

  // ---------------------------------------------------------------------------
  // The other thirty.
  //
  // Ten species had a voice and thirty did not, including all thirteen
  // monsters: a yeti closed on you and killed you in silence. That is not a
  // polish gap, it is a fairness one — a hostile you cannot hear is a hostile
  // you cannot turn around for.
  //
  // The trap when authoring thirty at once is that they all become the same
  // filtered sawtooth at thirty different pitches, which tells a player no more
  // than silence did. So the table below is spread across seven instruments,
  // and inside the biggest one (`roar`) the strongest tell is deliberately NOT
  // the fundamental but `rough[1]`, the rate the voice is chopped at: 5 Hz is a
  // slow bellow, 24 Hz is a shredding growl and 61 Hz is past the ear's ability
  // to hear separate pulses at all and reads as buzzing distortion. Two roars a
  // fifth apart sound like one animal; two roars at 5 Hz and 61 Hz never do.
  //
  // Every gain below was set by rendering the sound through an
  // OfflineAudioContext and measuring 400Hz-weighted RMS over a fixed 2.5s
  // window, the same meter the retune above used, never by ear. The measured
  // figure sits in the comment beside each group. On that meter the existing
  // rows re-measure as: koala -31.3, cow -31.8, deer -34.2, husk -35.2,
  // bunny -35.9, penguin -38.5, parrot -38.6, chick -40.1, fox -42.3, with
  // break-metal at -35.3 and a footstep at -58.9.
  //
  // The whole roster as it now measures (idle, dry, mean of eight renders):
  //
  //   merchant -26.5 | dragon -27.8 | cyclops -29.6 | elephant -30.6
  //   yeti -30.6 | koala -31.0 | lion -31.3 | cow -31.6 | cthulhu -32.0
  //   polar -32.0 | demon -32.1 | alien_tall -32.9 | tiger -33.0
  //   alien -33.1 | ghost -33.6 | cactus -34.2 | deer -34.4 | panda -34.5
  //   husk -34.6 | skull -34.7 | imp -34.8 | cat -35.0 | dog -35.2
  //   bunny -36.1 | sporeling -36.2 | monkey -36.2 | shark -36.0
  //   beaver -37.0 | bat -37.8 | penguin -38.0 | giraffe -38.5
  //   parrot -38.7 | fox -39.0 | bee -40.0 | chick -40.2 | crab -40.6
  //   piranha -42.4 | deep_fish -42.8 | fish -43.7 | caterpillar -46.3
  //
  // and the stalker, which is silence and must stay silence. The dragon is
  // 12.4dB over the chicken and second only to the merchant's bell, which is a
  // landmark rather than a voice. Every monster is above every fish.
  //
  // Attack windups measure 1.5 to 3.7dB over the same species' idle, which is
  // the point of the mode: the cue you must react to arrives louder than the
  // ambient chatter it has to cut through.

  // --- the thirteen that want you dead -------------------------------------
  //
  // Placed at the loud end on purpose: every one of these is louder than the
  // chick (-40.1) and the loudest of them, the dragon, is inside 2dB of the
  // merchant's bell, which is the loudest voice in the game.
  //
  // `urgent` lifts a species out of the shared 0.45s idle floor. That floor
  // exists so a paddock of forty animals cannot stack, and a monster's approach
  // tell being swallowed by a sheep standing between you is exactly the failure
  // this whole table is here to fix.
  yeti: {
    // Ape-chested and mostly air. Lowest of the roars bar the cyclops, and by
    // far the breathiest — you hear the lungs before the larynx.
    kind: 'roar', base: 78, dur: 1.45, gain: 0.115, urgent: true,
    rough: [0.45, 24], form: [380, 820], breath: 0.55, swell: 0.28, sub: 0.5,
  },
  cyclops: {
    // A foghorn, not an animal. Slowest modulation in the game at 5Hz, almost
    // no breath, a low vowel pair: one enormous sustained note that arrives
    // before it does.
    kind: 'roar', base: 58, dur: 2.05, gain: 0.128, urgent: true,
    rough: [0.10, 5], form: [260, 540], breath: 0.08, swell: 0.45, sub: 0.7,
  },
  demon: {
    // The opposite end of the same instrument. 61Hz modulation puts the
    // sidebands into the audible band, and the 1.48 partial is deliberately
    // inharmonic, so it reads as tearing rather than as a pitch.
    kind: 'roar', base: 168, dur: 0.85, gain: 0.078, urgent: true,
    rough: [0.55, 61], form: [900, 1900], breath: 0.25, swell: 0.05, harsh: true,
  },
  dragon: {
    // The loudest voice on the planet bar the merchant, and the only one with a
    // hiss laid over the tail: the roar ends and the flame keeps going.
    kind: 'roar', base: 92, dur: 1.90, gain: 0.112, urgent: true,
    rough: [0.30, 17], form: [500, 1100], breath: 0.75, swell: 0.20, sub: 0.8,
    hiss: 0.5,
  },
  cthulhu: {
    // Wet. A drowned groan with bubbles rising through it, heavily low-passed
    // as though heard through water even in the air.
    kind: 'gurgle', base: 74, dur: 1.55, gain: 0.6, urgent: true,
  },
  greendemon: {
    // Rhythm carries this one, not pitch: six clipped grains in half a second,
    // high and falling. The only monster that reads as fast rather than heavy.
    kind: 'chitter', base: 470, dur: 0.62, gain: 0.338, urgent: true,
    grains: 6, gap: 0.075, glide: 0.72, wave: 'square', band: 1600,
  },
  skull: {
    // No pitch at all, anywhere in it. Six dry high-Q noise grains — bone on
    // bone — which is why it can sit beside twelve tuned monsters and never be
    // mistaken for one of them.
    kind: 'noisevox', base: 1, dur: 0.55, gain: 2.45, urgent: true,
    grains: 6, gap: 0.055, lo: 900, hi: 3400, q: 6, at: 0.002,
  },
  alien: {
    // Electronic on purpose. A sine ring-modulated at 130Hz with a 17Hz warble
    // over it: no throat could make this, and nothing else here is inharmonic
    // in that particular way.
    kind: 'tonal', base: 640, dur: 0.70, gain: 0.096, urgent: true,
    wave: 'sine', vib: [17, 0.22], glide: [0.80, 1.35, 1.00], ring: 130,
  },
  alien_tall: {
    // Its stillness is the tell. Two sines 3.5Hz apart beating against each
    // other, almost no glide — where the small alien flutters, this hangs.
    kind: 'tonal', base: 208, dur: 1.70, gain: 0.098, urgent: true,
    wave: 'sine', vib: [0.8, 0.012], glide: [0.99, 1.01, 0.97], beat: 3.5,
  },
  ghost: {
    // Pure tone, no noise layer whatsoever, and a slow 4.5Hz swell. The one
    // monster that sounds like it is not touching the ground.
    kind: 'tonal', base: 300, dur: 2.00, gain: 0.065, urgent: true,
    wave: 'sine', vib: [4.5, 0.055], glide: [1.00, 1.28, 0.55], form: 900,
  },
  cactus_monster: {
    // A bow drawn across dry wood: one sustained mid band with an 11Hz tremolo
    // cut into it. Unpitched like the skull, but continuous where the skull
    // clatters.
    kind: 'noisevox', base: 1, dur: 0.80, gain: 0.635, urgent: true,
    grains: 1, lo: 700, hi: 2100, q: 2.5, at: 0.06, trem: 11,
  },
  mushroom_monster: {
    // Deliberately soft — two low breathy puffs and a dull pop. It is the
    // weakest thing on the list (3 damage) and it should sound like it, so the
    // roster has a bottom for the dragon to have a top of.
    kind: 'noisevox', base: 190, dur: 0.75, gain: 0.752, urgent: true,
    grains: 2, gap: 0.20, lo: 260, hi: 900, q: 0.9, at: 0.05, pop: 0.5,
  },
  bat: {
    // The highest thing in the game by an octave and a half. Short, faint and
    // above everything else in the mix, which is how you place one in the dark
    // without ever seeing it.
    kind: 'chitter', base: 3100, dur: 0.20, gain: 0.64, urgent: true,
    grains: 2, gap: 0.055, glide: 0.45, wave: 'sine', band: 5200,
  },

  // --- the large animals ---------------------------------------------------
  //
  // Same roar instrument as the monsters, kept apart from them by modulation
  // rate and by register, and about 2dB quieter as a group: none of these hunts
  // you, and a lion you have not provoked should not read as a dragon.
  lion: {
    // A real swell — the longest attack of the cats — over a slow 9Hz rasp.
    kind: 'roar', base: 108, dur: 1.40, gain: 0.078,
    rough: [0.16, 9], form: [640, 1250], breath: 0.22, swell: 0.35, sub: 0.45,
  },
  tiger: {
    // A chuff, not a roar: short, no swell at all, and a 33Hz rattle that is
    // nearly four times the lion's. The two are never confusable even though
    // they are a third apart.
    kind: 'roar', base: 138, dur: 0.80, gain: 0.091,
    rough: [0.60, 33], form: [560, 1150], breath: 0.30, swell: 0.06,
  },
  polar: {
    kind: 'roar', base: 86, dur: 1.20, gain: 0.094,
    rough: [0.28, 14], form: [340, 760], breath: 0.40, swell: 0.25, sub: 0.4,
  },
  elephant: {
    // The only voice in the table that goes UP. `rise` sends it from a seventh
    // below the fundamental to a fifth above in the first third, through a
    // bright formant pair — which is the whole difference between a trumpet and
    // a bellow.
    kind: 'roar', base: 118, dur: 1.45, gain: 0.065,
    rough: [0.12, 6.5], form: [1200, 2400], breath: 0.30, swell: 0.10, rise: 1.55,
  },
  giraffe: {
    // Almost mute in life, and left almost mute here: one long low breath and
    // no larynx at all. It is the quietest land animal on the planet.
    kind: 'noisevox', base: 1, dur: 0.95, gain: 0.369,
    grains: 1, lo: 180, hi: 700, q: 0.8, at: 0.14,
  },
  panda: {
    // The ruminant instrument, a fourth under the deer so a mixed enclosure
    // still separates.
    kind: 'bleat', base: 158, dur: 0.62, gain: 0.352,
  },

  // --- the ones a player actually lives beside -----------------------------
  dog: {
    // Two hard grains 0.17s apart with a fast fall on each. The gap is the
    // bark: three grains reads as a yap and one as a cough.
    kind: 'chitter', base: 260, dur: 0.40, gain: 0.84,
    grains: 2, gap: 0.17, glide: 0.55, wave: 'sawtooth', band: 900,
  },
  cat: {
    // A vowel with a hinge in it — up a fourth, then down past where it
    // started — under a 1100Hz formant. The glide shape is the meow; the same
    // oscillator without it is just a tone.
    kind: 'tonal', base: 480, dur: 0.65, gain: 0.079,
    wave: 'triangle', vib: [6, 0.03], glide: [0.75, 1.25, 0.60], form: 1100,
  },
  monkey: {
    // Three grains that each rise, against the dog's two that each fall. Same
    // instrument, opposite gesture.
    kind: 'chitter', base: 380, dur: 0.50, gain: 1.14,
    grains: 3, gap: 0.13, glide: 1.90, wave: 'triangle', band: 1400,
  },
  beaver: {
    kind: 'chitter', base: 520, dur: 0.42, gain: 0.49,
    grains: 3, gap: 0.09, glide: 1.25, wave: 'sawtooth', band: 1200,
  },
  bee: {
    // Sustained, which nothing else here is. A 42Hz amplitude chop on a
    // band-limited saw, wandering slightly in pitch so a swarm does not phase
    // into one tone.
    kind: 'buzz', base: 205, dur: 0.85, gain: 0.14,
  },
  crab: {
    // Chitin. Four ultra-short high-Q clicks and nothing else — the driest
    // sound in the game.
    kind: 'noisevox', base: 1, dur: 0.30, gain: 3.03,
    grains: 4, gap: 0.045, lo: 2400, hi: 5200, q: 9, at: 0.001,
  },
  caterpillar: {
    // Barely there, and it should be: a leaf-rustle at the very bottom of the
    // ladder, quieter than a footstep.
    kind: 'noisevox', base: 1, dur: 0.35, gain: 0.43,
    grains: 3, gap: 0.08, lo: 2600, hi: 6200, q: 1.4, at: 0.01,
  },

  // --- underwater ----------------------------------------------------------
  //
  // Quiet by design and quieter still in play, because the muffle filter is
  // closed to a few hundred Hz whenever the player is under with them. A fish
  // is a texture you notice when you are already swimming, not a call across a
  // bay.
  fish: { kind: 'bubble', base: 420, dur: 0.45, gain: 0.119 },
  deep_fish: { kind: 'bubble', base: 300, dur: 0.60, gain: 0.158 },
  piranha: {
    // Not a bubble: a dry snapping run, the one aquatic voice that is a warning.
    kind: 'chitter', base: 1500, dur: 0.26, gain: 0.202,
    grains: 4, gap: 0.042, glide: 0.90, wave: 'square', band: 3000,
  },
  shark: {
    // No animal noise at all — a pressure wave. Low-passed noise swelling and
    // closing over a falling sub, which is the sound of something large moving
    // water, and the only honest thing a shark can be given.
    kind: 'surge', base: 64, dur: 1.30, gain: 0.378,
  },

  // The stalker is not on this table and must never be. `_tryVocalise` returns
  // early for phantoms and Audio.mob would refuse him anyway; a sighting that
  // announces itself is a jump scare, and the whole effect is that nothing
  // happens at all.
};

// idle / attack / hurt / death are the same instrument played differently.
//
// `drop` is where the pitch ends up as a multiple of where it began, and it is
// what separates the two aggressive modes from the two passive ones: under 1
// the voice falls away, over 1 it climbs. A hurt climbs a little because it is
// involuntary; an attack climbs harder, in the chest register rather than up a
// third, because it is a decision.
const VOX_MODE = {
  idle: { pitch: 1.0, dur: 1.0, gain: 1.0, drop: 0.86, thump: 0 },
  // The windup. Louder and longer than a hurt and NOT pitched up: a monster
  // squealing as it lunges reads as a monster taking damage, which is precisely
  // backwards at the one moment the player has to read it right.
  attack: { pitch: 0.98, dur: 0.72, gain: 1.5, drop: 1.30, thump: 0 },
  hurt: { pitch: 1.34, dur: 0.62, gain: 1.35, drop: 1.18, thump: 0 },
  death: { pitch: 0.92, dur: 1.75, gain: 1.15, drop: 0.42, thump: 0.9 },
};

// Concurrent-voice budget, in weighted units. The weights are roughly the node
// count each category builds, so the ceiling means something: at the cap the
// graph holds on the order of 500 transient nodes, which measures as noise
// beside the voxel meshes this game already keeps resident.
const VOICE_BUDGET = 64;
//
// `sky` exists because of a measurement rather than a theory. The weather front
// and the turn of the day were first put on `amb`, which is the right weight for
// them — they build four to nine nodes, nothing like thunder's twenty — but
// `amb` is also where every bird, owl, drip and gust one-shot lands, at the same
// cost 3 against a cap of 12. Four of those in flight fills the category, and a
// storm front arriving was measured being DROPPED by birdsong. A warning a
// sparrow can mute is not a warning. Its own category at cost 4 and cap 8 costs
// the global budget almost nothing (a squall and a sunset can coincide; nothing
// else in here is a sky event) and cannot be starved by the ambience bed.
const VOICE_COST = {
  step: 2, block: 3, mob: 7, hit: 3, player: 3, ui: 1, amb: 3, weather: 10, sky: 4,
};
// Per-category ceilings on top of the global one, so no single source can eat
// the whole budget. A cave-in must not be able to silence your own footsteps.
const VOICE_CAP = {
  step: 8, block: 24, mob: 28, hit: 12, player: 9, ui: 6, amb: 12, weather: 20, sky: 8,
};

export class Audio {
  constructor() {
    this.ctx = null;
    // Written only by `setVolumes`: a master volume of zero is off, not quiet.
    this.enabled = true;
    this.masterVolume = 0.7;
    this.musicVolume = 0.35;
    this.started = false;
    // debug/verification counters — cheap, and the only way to confirm the
    // graph is doing anything at all in a headless browser
    this.stats = {
      panners: 0, mobCalls: 0, thunder: 0, throttled: 0,
      voicesTaken: 0, voicesDropped: 0, peakVoices: 0,
    };
    this._lastIdleVox = -99;
    // panners following a live position object (a mob's own vector), re-read
    // every frame so a call from a running animal moves with it
    this._tracked = [];
    this._used = 0;
    this._cat = {};
    this._muffle = 0;
  }

  start() {
    if (this.started) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.started = true;

    this.master = this.ctx.createGain();
    this.master.gain.value = this.masterVolume;

    // The underwater filter. Wide open is a no-op the browser optimises away;
    // it only costs anything while it is actually closed.
    this.muffle = this.ctx.createBiquadFilter();
    this.muffle.type = 'lowpass';
    this.muffle.frequency.value = 20000;
    this.muffle.Q.value = 0.6;

    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 22; comp.ratio.value = 5;
    comp.attack.value = 0.004; comp.release.value = 0.22;
    this.master.connect(this.muffle).connect(comp).connect(this.ctx.destination);

    this.sfxBus = this.ctx.createGain(); this.sfxBus.gain.value = 1;
    this.sfxBus.connect(this.master);

    // UI sits on its own bus so menu clicks keep a steady level whatever the
    // world is doing, and so it can duck out from under the muffle later.
    this.uiBus = this.ctx.createGain(); this.uiBus.gain.value = 0.9;
    this.uiBus.connect(this.master);

    // Ambience is separate from sfx: it must not be pushed around by the
    // reverb send, and its level has to be trimmable on its own.
    this.ambBus = this.ctx.createGain(); this.ambBus.gain.value = 1;
    this.ambBus.connect(this.master);

    // small convolution space so impacts don't sound dry
    this.reverb = this.ctx.createConvolver();
    this.reverb.buffer = this._impulse(1.5, 2.6);
    this.reverbGain = this.ctx.createGain(); this.reverbGain.gain.value = 0.16;
    this.sfxBus.connect(this.reverbGain).connect(this.reverb).connect(this.master);

    this.noiseBuf = this._noise(2.5);
    this._startAmbience();
    this._startMusic();
  }

  // --- voice budget ----------------------------------------------------------

  /**
   * Reserve budget for one voice of `cat` lasting `life` seconds. False means
   * the caller must build nothing at all — checking this after wiring up half a
   * graph would defeat the point.
   */
  _take(cat, life = 0.5) {
    const cost = VOICE_COST[cat] || 3;
    const cap = VOICE_CAP[cat] || 12;
    const used = this._cat[cat] || 0;
    if (this._used + cost > VOICE_BUDGET || used + cost > cap) {
      this.stats.voicesDropped++;
      return false;
    }
    this._used += cost;
    this._cat[cat] = used + cost;
    this.stats.voicesTaken++;
    if (this._used > this.stats.peakVoices) this.stats.peakVoices = this._used;
    setTimeout(() => {
      this._used = Math.max(0, this._used - cost);
      this._cat[cat] = Math.max(0, (this._cat[cat] || 0) - cost);
    }, Math.max(60, life * 1000 + 120));
    return true;
  }

  resume() { if (this.ctx?.state === 'suspended') this.ctx.resume(); }

  // --- positional plumbing ---------------------------------------------------

  /** True once a context exists, is running, and output is wanted. */
  _live() {
    return !!(this.ctx && this.enabled && this.ctx.state !== 'closed'
      && this.ctx.state !== 'suspended');
  }

  /**
   * Drive the AudioListener from the camera. `up` must be the player's local up
   * on the sphere — using world +Y would swing the stereo image as you walk
   * around the planet. Modern per-AudioParam setters with a fallback to the
   * deprecated setPosition/setOrientation for older Safari/Firefox.
   */
  setListener(px, py, pz, fx, fy, fz, ux, uy, uz) {
    if (!this.ctx) return;
    const L = this.ctx.listener;
    if (!L) return;
    try {
      const t = this.ctx.currentTime;
      if (L.positionX) {
        // a short ramp instead of a hard set kills zipper noise on fast turns
        const k = 0.02;
        L.positionX.linearRampToValueAtTime(px, t + k);
        L.positionY.linearRampToValueAtTime(py, t + k);
        L.positionZ.linearRampToValueAtTime(pz, t + k);
        L.forwardX.linearRampToValueAtTime(fx, t + k);
        L.forwardY.linearRampToValueAtTime(fy, t + k);
        L.forwardZ.linearRampToValueAtTime(fz, t + k);
        L.upX.linearRampToValueAtTime(ux, t + k);
        L.upY.linearRampToValueAtTime(uy, t + k);
        L.upZ.linearRampToValueAtTime(uz, t + k);
      } else {
        L.setPosition(px, py, pz);
        L.setOrientation(fx, fy, fz, ux, uy, uz);
      }
      this._followSources();
    } catch (e) { /* never let audio break the frame loop */ }
  }

  /** Re-point panners whose source object is still moving; drop dead ones. */
  _followSources() {
    if (!this._tracked.length) return;
    const t = this.ctx.currentTime;
    for (let i = this._tracked.length - 1; i >= 0; i--) {
      const e = this._tracked[i];
      if (t > e.until) { this._tracked.splice(i, 1); continue; }
      const p = e.node, s = e.pos;
      if (p.positionX) {
        p.positionX.value = s.x;
        p.positionY.value = s.y;
        p.positionZ.value = s.z;
      } else p.setPosition(s.x, s.y, s.z);
    }
  }

  /**
   * Destination for one voice. With a world position it is a fresh PannerNode
   * feeding the sfx bus (so master/music volume and the reverb send still apply);
   * without one it is the dry bus.
   */
  _dest(pos, life = 1, track = false, far = false) {
    if (!pos || !this.ctx) return this.sfxBus;
    let p;
    try {
      p = this.ctx.createPanner();
      p.panningModel = 'HRTF';
      p.distanceModel = 'inverse';
      p.refDistance = far ? FAR_REF_DISTANCE : REF_DISTANCE;
      p.maxDistance = MAX_DISTANCE;
      p.rolloffFactor = far ? FAR_ROLLOFF : ROLLOFF;
      p.coneInnerAngle = 360;
      p.coneOuterAngle = 360;
      p.coneOuterGain = 1;
      const x = pos.x ?? pos[0] ?? 0, y = pos.y ?? pos[1] ?? 0, z = pos.z ?? pos[2] ?? 0;
      if (p.positionX) {
        p.positionX.value = x;
        p.positionY.value = y;
        p.positionZ.value = z;
      } else {
        p.setPosition(x, y, z);
      }
    } catch (e) {
      return this.sfxBus;
    }
    p.connect(this.sfxBus);
    this.stats.panners++;
    // Only follow objects the caller promises are stable and live — block
    // sounds are handed a shared scratch vector that is recycled next frame.
    if (track && pos && pos.x !== undefined && this._tracked.length < 24) {
      this._tracked.push({ node: p, pos, until: this.ctx.currentTime + life });
    }
    this._reap(p, life);
    return p;
  }

  /** Drop a transient node out of the graph once its voice has finished. */
  _reap(node, life) {
    setTimeout(() => { try { node.disconnect(); } catch (e) { /* already gone */ } },
      Math.max(50, life * 1000 + 400));
  }

  _noise(seconds) {
    const n = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < n; i++) {
      const w = Math.random() * 2 - 1;
      // gently pinkened noise reads warmer than pure white
      b0 = 0.99765 * b0 + w * 0.0990460;
      b1 = 0.96300 * b1 + w * 0.2965164;
      b2 = 0.57000 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.22;
    }
    return buf;
  }

  _impulse(seconds, decay) {
    const rate = this.ctx.sampleRate;
    const n = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(2, n, rate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay);
      }
    }
    return buf;
  }

  _burst(mat, { gain = 0.5, pitch = 1, dur = 1, pos = null, cat = 'block' } = {}) {
    if (!this._live()) return false;
    const cfg = MATERIAL_TUNING[mat] || MATERIAL_TUNING.stone;
    const life = cfg.decay * dur;
    if (!this._take(cat, life * 1.6 + 0.1)) return false;
    const t = this.ctx.currentTime;
    const out = this._dest(pos, life * 1.6 + 0.1);

    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.85 + Math.random() * 0.3;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = (cfg.lo + Math.random() * (cfg.hi - cfg.lo)) * pitch;
    bp.Q.value = 0.9 + Math.random() * 1.2;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = cfg.lo * 0.5;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain * cfg.noise, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0008, t + life);
    src.connect(bp).connect(hp).connect(g).connect(out);
    src.start(t, Math.random() * 2);
    src.stop(t + life + 0.05);

    if (cfg.body > 0) {
      const o = this.ctx.createOscillator();
      o.type = mat === 'metal' || mat === 'glass' ? 'triangle' : 'sine';
      o.frequency.setValueAtTime(cfg.body * pitch * (0.9 + Math.random() * 0.2), t);
      o.frequency.exponentialRampToValueAtTime(cfg.body * pitch * 0.55, t + life);
      const og = this.ctx.createGain();
      og.gain.setValueAtTime(0, t);
      og.gain.linearRampToValueAtTime(gain * cfg.tone, t + 0.006);
      og.gain.exponentialRampToValueAtTime(0.0006, t + life * 1.5);
      o.connect(og).connect(out);
      o.start(t); o.stop(t + life * 1.6);
    }
    return true;
  }

  // Player-centric by default; `pos` (a THREE.Vector3 or [x,y,z]) makes any of
  // these world-anchored.

  /**
   * A footstep. Two layers, not one: the impact of the boot, plus a quieter
   * scuff a few milliseconds behind it as the foot rolls. A single burst is
   * what made every surface sound like the same tap at different pitches.
   * Sand, snow and grass get a long soft scuff; stone and wood get a short one.
   */
  step(mat, pos) {
    const cfg = MATERIAL_TUNING[mat] || MATERIAL_TUNING.stone;
    if (mat === 'water') return this._waterStep(pos);
    const pitch = 0.85 + Math.random() * 0.25;
    if (!this._burst(mat, { gain: 0.20, pitch, dur: 0.9, pos, cat: 'step' })) return;
    const soft = mat === 'sand' || mat === 'snow' || mat === 'grass' || mat === 'soil';
    const t = this.ctx.currentTime + 0.012 + Math.random() * 0.02;
    const d = (soft ? 0.11 : 0.05) * (0.8 + Math.random() * 0.5);
    const out = this._dest(pos, d + 0.2);
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.8 + Math.random() * 0.5;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(cfg.hi * 0.7 * pitch, t);
    bp.frequency.exponentialRampToValueAtTime(Math.max(60, cfg.lo * 0.8), t + d);
    bp.Q.value = 0.5;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.075 * (soft ? 1.25 : 0.8), t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0004, t + d);
    src.connect(bp).connect(g).connect(out);
    src.start(t, Math.random() * 2); src.stop(t + d + 0.05);
  }

  dig(mat, pos) { this._burst(mat, { gain: 0.18, pitch: 1.1, dur: 0.55, pos }); }
  break_(mat, pos) { this._burst(mat, { gain: 0.5, pitch: 0.9, dur: 1.7, pos }); }
  place(mat, pos) { this._burst(mat, { gain: 0.42, pitch: 1.15, dur: 1.1, pos }); }

  /** Walking through shallow water: a wet slosh with no hard transient at all. */
  _waterStep(pos) {
    if (!this._live() || !this._take('step', 0.45)) return;
    const t = this.ctx.currentTime;
    const d = 0.18 + Math.random() * 0.12;
    const out = this._dest(pos, d + 0.3);
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.9 + Math.random() * 0.5;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(400 + Math.random() * 300, t);
    bp.frequency.exponentialRampToValueAtTime(2200 + Math.random() * 1400, t + d * 0.6);
    bp.Q.value = 0.8;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.20, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0004, t + d);
    src.connect(bp).connect(g).connect(out);
    src.start(t, Math.random() * 2); src.stop(t + d + 0.05);
  }

  /**
   * Water displaced. A broadband slap, a body of noise falling away behind it,
   * and a short run of rising bubble resonances — the rise is what makes it
   * water rather than a burst of static. Scale 1 is a body entering; the
   * fishing float and a bucket pass smaller numbers.
   */
  splash(pos, scale = 1) {
    if (!this._live() || !this._take('player', 1.0)) return;
    const t = this.ctx.currentTime;
    const d = (0.5 + Math.random() * 0.35) * scale;
    const out = this._dest(pos, d * 1.6 + 0.4);

    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.9 + Math.random() * 0.4;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(2600 + Math.random() * 1800, t);
    bp.frequency.exponentialRampToValueAtTime(320, t + d);
    bp.Q.value = 0.6;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.34 * scale, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0004, t + d);
    src.connect(bp).connect(g).connect(out);
    src.start(t, Math.random() * 2); src.stop(t + d + 0.05);

    const n = 2 + ((Math.random() * 4 * scale) | 0);
    for (let i = 0; i < n; i++) {
      const tn = t + 0.02 + i * (0.02 + Math.random() * 0.06);
      const bd = 0.04 + Math.random() * 0.06;
      const f = 300 + Math.random() * 800;
      const o = this.ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(f, tn);
      o.frequency.exponentialRampToValueAtTime(f * (2 + Math.random() * 1.6), tn + bd);
      const bg = this.ctx.createGain();
      bg.gain.setValueAtTime(0.0001, tn);
      bg.gain.linearRampToValueAtTime(0.10 * scale, tn + 0.004);
      bg.gain.exponentialRampToValueAtTime(0.0004, tn + bd);
      o.connect(bg).connect(out);
      o.start(tn); o.stop(tn + bd + 0.03);
    }
  }

  /** One swimming stroke. Deliberately soft; it repeats every second or so. */
  swim(pos) {
    if (!this._live() || !this._take('step', 0.5)) return;
    const t = this.ctx.currentTime;
    const d = 0.3 + Math.random() * 0.2;
    const out = this._dest(pos, d + 0.3);
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.5 + Math.random() * 0.3;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(900 + Math.random() * 500, t);
    lp.frequency.exponentialRampToValueAtTime(200, t + d);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.11, t + d * 0.3);
    g.gain.exponentialRampToValueAtTime(0.0004, t + d);
    src.connect(lp).connect(g).connect(out);
    src.start(t, Math.random() * 2); src.stop(t + d + 0.05);
  }

  /** Breaking the surface: the splash plus a gasp. */
  surface() {
    this.splash(null, 0.7);
    if (!this._live() || !this._take('player', 0.5)) return;
    const t = this.ctx.currentTime + 0.05;
    const d = 0.34;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 1.1;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(500, t);
    bp.frequency.exponentialRampToValueAtTime(1500, t + d * 0.5);
    bp.Q.value = 1.6;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.16, t + 0.09);
    g.gain.exponentialRampToValueAtTime(0.0004, t + d);
    src.connect(bp).connect(g).connect(this.sfxBus);
    src.start(t, Math.random() * 2); src.stop(t + d + 0.05);
  }

  /**
   * Taking a hit. The original was one sawtooth drop, which read as an arcade
   * buzzer; the sharp intake of breath over the top is what makes it a body.
   */
  hurt() {
    if (!this._live() || !this._take('player', 0.5)) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(220 * (0.9 + Math.random() * 0.2), t);
    o.frequency.exponentialRampToValueAtTime(70, t + 0.28);
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 900;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.26, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
    o.connect(f).connect(g).connect(this.sfxBus);
    o.start(t); o.stop(t + 0.36);
    this._noiseHit(this.sfxBus, t, { gain: 0.13, lo: 900, hi: 300, q: 1.4, dur: 0.2, at: 0.02 });
  }

  /** Player death: the hurt, then everything falling away underneath it. */
  death() {
    this.hurt();
    if (!this._live() || !this._take('player', 2.2)) return;
    const t = this.ctx.currentTime + 0.12;
    const d = 1.8;
    for (const [mul, amt] of [[1, 1], [0.5, 0.7], [1.5, 0.28]]) {
      const o = this.ctx.createOscillator();
      o.type = mul === 1.5 ? 'triangle' : 'sine';
      o.frequency.setValueAtTime(196 * mul, t);
      o.frequency.exponentialRampToValueAtTime(Math.max(24, 44 * mul), t + d);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.16 * amt, t + 0.05);
      g.gain.exponentialRampToValueAtTime(0.0004, t + d);
      o.connect(g).connect(this.sfxBus);
      o.start(t); o.stop(t + d + 0.1);
    }
  }

  pickup() {
    if (!this._live() || !this._take('ui', 0.3)) return;
    const t = this.ctx.currentTime;
    [660, 880].forEach((f, i) => {
      const o = this.ctx.createOscillator();
      o.type = 'sine'; o.frequency.value = f;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, t + i * 0.06);
      g.gain.linearRampToValueAtTime(0.14, t + i * 0.06 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0005, t + i * 0.06 + 0.16);
      o.connect(g).connect(this.uiBus);
      o.start(t + i * 0.06); o.stop(t + i * 0.06 + 0.2);
    });
  }

  /**
   * The generic interface blip. Still one square, because dozens of call sites
   * pass nothing but a frequency and expect a click — but now with a fast pitch
   * drop and a lowpass on it, which is the difference between a click and the
   * flat beep this used to be. Everything menu-shaped runs through here.
   */
  ui(freq = 520) {
    if (!this._live() || !this._take('ui', 0.15)) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'square';
    o.frequency.setValueAtTime(freq * 1.06, t);
    o.frequency.exponentialRampToValueAtTime(freq, t + 0.03);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = Math.min(9000, freq * 5.5); lp.Q.value = 0.7;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    // 0.05 measured at -51.5 weighted, the quietest thing in the game bar the
    // bow creak, on the voice that answers every menu action there is.
    g.gain.linearRampToValueAtTime(0.075, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0004, t + 0.09);
    o.connect(lp).connect(g).connect(this.uiBus);
    o.start(t); o.stop(t + 0.1);
  }

  /** Refused. A flat, dull two-tone fall; unmistakably not a confirmation. */
  deny() {
    if (!this._live() || !this._take('ui', 0.3)) return;
    const t = this.ctx.currentTime;
    [[230, 0], [172, 0.075]].forEach(([f, dt]) => {
      const o = this.ctx.createOscillator();
      o.type = 'square'; o.frequency.value = f;
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 1100;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, t + dt);
      g.gain.linearRampToValueAtTime(0.055, t + dt + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0004, t + dt + 0.10);
      o.connect(lp).connect(g).connect(this.uiBus);
      o.start(t + dt); o.stop(t + dt + 0.12);
    });
  }

  /** Something went wrong and the player needs to know without reading. */
  saveFail() {
    if (!this._live() || !this._take('ui', 0.7)) return;
    const t = this.ctx.currentTime;
    for (let i = 0; i < 3; i++) {
      const tn = t + i * 0.13;
      const o = this.ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(150, tn);
      o.frequency.exponentialRampToValueAtTime(96, tn + 0.11);
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 800;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, tn);
      g.gain.linearRampToValueAtTime(0.09, tn + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0004, tn + 0.12);
      o.connect(lp).connect(g).connect(this.uiBus);
      o.start(tn); o.stop(tn + 0.14);
    }
  }

  /** Progress. A rising arpeggio with a bell on top; the only fanfare here. */
  levelUp() {
    if (!this._live() || !this._take('ui', 1.4)) return;
    const t = this.ctx.currentTime;
    const root = 440;
    [0, 4, 7, 12].forEach((semi, i) => {
      const f = root * Math.pow(2, semi / 12);
      const tn = t + i * 0.085;
      for (const [mul, amt, type] of [[1, 1, 'sine'], [2, 0.3, 'triangle']]) {
        const o = this.ctx.createOscillator();
        o.type = type; o.frequency.value = f * mul;
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0, tn);
        g.gain.linearRampToValueAtTime(0.085 * amt, tn + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0004, tn + (i === 3 ? 0.9 : 0.28));
        o.connect(g).connect(this.uiBus);
        if (this.reverbGain) g.connect(this.reverbGain);
        o.start(tn); o.stop(tn + (i === 3 ? 1.0 : 0.32));
      }
    });
  }

  /** Chewing, then a swallow. Four irregular wet grains, no two the same. */
  eat() {
    if (!this._live() || !this._take('player', 0.9)) return;
    const t = this.ctx.currentTime;
    const bites = 3 + ((Math.random() * 2) | 0);
    for (let i = 0; i < bites; i++) {
      const tn = t + i * (0.13 + Math.random() * 0.08);
      const d = 0.07 + Math.random() * 0.05;
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      src.playbackRate.value = 0.7 + Math.random() * 0.6;
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(900 + Math.random() * 1400, tn);
      bp.frequency.exponentialRampToValueAtTime(300, tn + d);
      bp.Q.value = 1.1;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, tn);
      g.gain.linearRampToValueAtTime(0.13, tn + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0004, tn + d);
      src.connect(bp).connect(g).connect(this.sfxBus);
      src.start(tn, Math.random() * 2); src.stop(tn + d + 0.03);
    }
    // the gulp: a short rising resonance, the same trick as a bubble
    const gt = t + bites * 0.15 + 0.05;
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(160, gt);
    o.frequency.exponentialRampToValueAtTime(430, gt + 0.12);
    const gg = this.ctx.createGain();
    gg.gain.setValueAtTime(0.0001, gt);
    gg.gain.linearRampToValueAtTime(0.10, gt + 0.02);
    gg.gain.exponentialRampToValueAtTime(0.0004, gt + 0.14);
    o.connect(gg).connect(this.sfxBus);
    o.start(gt); o.stop(gt + 0.16);
  }

  /** Bench work: a couple of knocks and a scrape. Not a chime, not a coin. */
  craft() {
    if (!this._live() || !this._take('player', 0.7)) return;
    const t = this.ctx.currentTime;
    for (let i = 0; i < 2; i++) {
      const tn = t + i * (0.10 + Math.random() * 0.05);
      const d = 0.12;
      const o = this.ctx.createOscillator();
      o.type = 'sine';
      const f = 190 * (i ? 0.8 : 1) * (0.9 + Math.random() * 0.2);
      o.frequency.setValueAtTime(f, tn);
      o.frequency.exponentialRampToValueAtTime(f * 0.55, tn + d);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, tn);
      g.gain.linearRampToValueAtTime(0.18, tn + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0004, tn + d);
      o.connect(g).connect(this.sfxBus);
      o.start(tn); o.stop(tn + d + 0.03);
      this._noiseHit(this.sfxBus, tn, { gain: 0.13, lo: 500, hi: 2600, q: 1.0, dur: 0.09 });
    }
    this._noiseHit(this.sfxBus, t + 0.24, { gain: 0.08, lo: 900, hi: 4200, q: 0.7, dur: 0.22, at: 0.05 });
  }

  /**
   * A kiln finishing a smelt. The one sound in the game that had to be new
   * rather than rewired: a kiln ran for twenty seconds and produced its ingot
   * in complete silence, so there was no way to know it was done without
   * standing over the screen.
   *
   * Two layers, and the order matters. First the breath of heat escaping as the
   * lid of the reaction gives — noise through a band that OPENS rather than
   * closes, which is what separates a release from an impact. Then, a beat
   * later, a dull struck tick: the thing itself, dropping into the tray.
   * Positional, because a kiln is a place you walk away from.
   */
  smelt(pos = null) {
    if (!this._live() || !this._take('block', 0.9)) return;
    const t = this.ctx.currentTime;
    const d = 0.55;
    const out = this._dest(pos, 1.2);

    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.55 + Math.random() * 0.2;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(320, t);
    bp.frequency.exponentialRampToValueAtTime(1900 + Math.random() * 600, t + d);
    bp.Q.value = 1.1;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.11, t + 0.12);
    g.gain.exponentialRampToValueAtTime(0.0004, t + d);
    src.connect(bp).connect(g).connect(out);
    src.start(t, Math.random() * 2); src.stop(t + d + 0.05);

    // the ingot landing: low, short, barely tuned — a kiln is fired clay, and
    // anything that rang here sounded like a bell instead of a workshop
    const tn = t + 0.30;
    const o = this.ctx.createOscillator();
    o.type = 'triangle';
    const f = 260 * (0.92 + Math.random() * 0.16);
    o.frequency.setValueAtTime(f, tn);
    o.frequency.exponentialRampToValueAtTime(f * 0.5, tn + 0.22);
    const og = this.ctx.createGain();
    og.gain.setValueAtTime(0.0001, tn);
    og.gain.linearRampToValueAtTime(0.17, tn + 0.004);
    og.gain.exponentialRampToValueAtTime(0.0004, tn + 0.24);
    o.connect(og).connect(out);
    o.start(tn); o.stop(tn + 0.26);
    this._noiseHit(out, tn, { gain: 0.11, lo: 600, hi: 3200, q: 1.0, dur: 0.07 });
  }

  /**
   * A kiln taking light, and a kiln going dark.
   *
   * Hooked to the block swapping between `kiln` and `kiln_lit` rather than to
   * the moment fuel is consumed, because fuel is consumed once per stick: a
   * furnace burning through a stack of nine would otherwise light nine times.
   * The block state changes exactly twice per run, which is the number of times
   * the player wants to be told.
   *
   * The two are one gesture played in opposite directions and nothing else, so
   * they cannot be confused with each other or with anything else here: lighting
   * OPENS a band upward over half a second, going out CLOSES one downward over
   * three quarters. Lighting measures -44.9 and going dark -49.3, which puts the
   * pair either side of `smelt` at -45.1 — the three things a kiln does sit on
   * one shelf — and makes going out the quieter: a thing stopping is news, but
   * it is not the same news as a thing starting, and only one of them is
   * something you did. The first cut had them the wrong way round (-47.3 lit
   * against -45.8 out), which read as the fire failing louder than it caught.
   *
   * Positional, and this is the whole point of the pair — the failure they fix
   * is loading a kiln, walking off to mine, and never learning that it ran out
   * of coal two minutes in.
   */
  kiln(lit = true, pos = null) {
    if (!this._live() || !this._take('block', 1.2)) return;
    const t = this.ctx.currentTime;
    const d = lit ? 0.55 : 0.78;
    const out = this._dest(pos, d + 0.6);

    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    // Stretched hard. Fire has no top end to speak of and a fast-running noise
    // buffer reads as a hiss of steam instead of a body of flame.
    src.playbackRate.value = 0.30 + Math.random() * 0.14;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 0.9;
    if (lit) {
      bp.frequency.setValueAtTime(180, t);
      bp.frequency.exponentialRampToValueAtTime(1250 + Math.random() * 350, t + d);
    } else {
      bp.frequency.setValueAtTime(900 + Math.random() * 250, t);
      bp.frequency.exponentialRampToValueAtTime(120, t + d);
    }
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    // A slow attack on the light — fuel catches, it does not strike. The dying
    // one is slower still, because nothing about running out is sudden.
    g.gain.linearRampToValueAtTime(lit ? 0.36 : 0.10, t + (lit ? 0.10 : 0.20));
    g.gain.exponentialRampToValueAtTime(0.0004, t + d);
    src.connect(bp).connect(g).connect(out);
    src.start(t, Math.random() * 2); src.stop(t + d + 0.05);

    // The low body under a lit kiln: the draught, held for a beat after the
    // catch. Only on the way up; there is nothing to sustain on the way down.
    if (lit) {
      const o = this.ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(74, t);
      o.frequency.linearRampToValueAtTime(58, t + 0.9);
      const og = this.ctx.createGain();
      og.gain.setValueAtTime(0.0001, t);
      og.gain.linearRampToValueAtTime(0.20, t + 0.16);
      og.gain.exponentialRampToValueAtTime(0.0004, t + 0.9);
      o.connect(og).connect(out);
      o.start(t); o.stop(t + 0.95);
    } else {
      // Two embers ticking as the heat leaves. Dry, unpitched, and the only
      // thing in either half that is a transient rather than a sweep.
      for (let i = 0; i < 2; i++) {
        this._noiseHit(out, t + 0.34 + i * (0.16 + Math.random() * 0.1),
          { gain: 0.04, lo: 900, hi: 2600, q: 5, dur: 0.05, at: 0.002 });
      }
    }
  }

  /**
   * A torch catching. Laid over the block-place tap rather than replacing it:
   * the tap is the stick meeting stone, and the flame is the reason you did it.
   *
   * Light is the resource this game's night is actually about, so the one
   * placement in the game worth confirming by ear is this one. Kept small
   * (-56.9, three and a half dB under the -53.5 tap it rides on) because a torch
   * is a confirmation, not an event — you know you placed it, you are looking
   * at it.
   *
   * No pitched layer anywhere in it. A flame has no fundamental, and every
   * attempt at one here read as a gas ring.
   */
  torchLight(pos = null) {
    if (!this._live() || !this._take('block', 0.8)) return;
    const t = this.ctx.currentTime;
    const d = 0.40;
    const out = this._dest(pos, 0.9);

    // the catch: a puff of air taking, band opening upward
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.45 + Math.random() * 0.2;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(300, t);
    bp.frequency.exponentialRampToValueAtTime(1600 + Math.random() * 500, t + d);
    bp.Q.value = 0.8;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.10, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0004, t + d);
    src.connect(bp).connect(g).connect(out);
    src.start(t, Math.random() * 2); src.stop(t + d + 0.05);

    // and the crackle settling in behind it, three grains at falling level
    for (let i = 0; i < 3; i++) {
      this._noiseHit(out, t + 0.10 + i * (0.07 + Math.random() * 0.08),
        { gain: 0.035 * (1 - i * 0.25), lo: 1200, hi: 4200, q: 4, dur: 0.035, at: 0.002 });
    }
  }

  /**
   * A door. `open` is which way it just went, and it is the whole reason this
   * exists: both halves used to be `place('wood')`, so the one block in the
   * game with two states told you nothing about which state it had reached.
   *
   * The tell is not pitch, it is how each one ENDS. Opening ends open — a hinge
   * band sweeping upward that simply stops being there. Closing ends closed —
   * a fast swing down into a hard latch and a low body thump, which is a full
   * stop. Played back to back the two are unmistakable with your eyes shut,
   * which is the test that matters: a base you have sealed behind you sounds
   * different from one you have not.
   *
   * -52.8 open and -53.0 shut, deliberately inside a fifth of a dB of each
   * other and sitting on the -53.5 block-place tap they replaced. Two states of
   * one object must differ in shape, not in loudness; the first cut had them
   * 5.3dB apart and that reads as two different doors.
   *
   * Positional. A door is a place, and hearing one from the wrong side of the
   * house is the point of it being a place.
   */
  door(open = true, pos = null) {
    if (!this._live() || !this._take('block', 0.9)) return;
    const t = this.ctx.currentTime;
    const out = this._dest(pos, 1.0);

    // The hinge. High Q, because a hinge is one narrow resonance being dragged
    // across a range rather than a band of noise: at Q 1 this is a whoosh, and
    // at Q 9 it is a rusted pin.
    const d = open ? 0.42 : 0.20;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = (open ? 0.30 : 0.55) + Math.random() * 0.15;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = open ? 9 : 5;
    const f0 = 520 * (0.9 + Math.random() * 0.2);
    bp.frequency.setValueAtTime(open ? f0 : f0 * 2.2, t);
    bp.frequency.exponentialRampToValueAtTime(open ? f0 * 2.4 : f0 * 0.75, t + d);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    // Opening is a drag: slow on, and it fades rather than lands. Closing is a
    // swing: it is already moving, so the noise is short and mostly a run-up.
    g.gain.linearRampToValueAtTime(open ? 0.24 : 0.095, t + (open ? 0.13 : 0.04));
    g.gain.exponentialRampToValueAtTime(0.0004, t + d);
    src.connect(bp).connect(g).connect(out);
    src.start(t, Math.random() * 2); src.stop(t + d + 0.05);

    // The stop. Open gets a light knock as the leaf comes to rest against the
    // frame; closed gets a hard latch and a low thump under it, and it is that
    // thump — a body arriving — that reads as shut.
    const tn = t + d * (open ? 0.95 : 0.80);
    this._noiseHit(out, tn, open
      ? { gain: 0.11, lo: 400, hi: 1700, q: 1.6, dur: 0.05 }
      : { gain: 0.15, lo: 500, hi: 2600, q: 1.2, dur: 0.06, at: 0.002 });
    if (!open) {
      const o = this.ctx.createOscillator();
      o.type = 'sine';
      const bf = 105 * (0.92 + Math.random() * 0.16);
      o.frequency.setValueAtTime(bf, tn);
      o.frequency.exponentialRampToValueAtTime(bf * 0.62, tn + 0.20);
      const og = this.ctx.createGain();
      og.gain.setValueAtTime(0.0001, tn);
      og.gain.linearRampToValueAtTime(0.17, tn + 0.005);
      og.gain.exponentialRampToValueAtTime(0.0004, tn + 0.22);
      o.connect(og).connect(out);
      o.start(tn); o.stop(tn + 0.24);
    }
  }

  /**
   * Water taking a lid, or losing one. `freeze` picks which.
   *
   * The caller must gate this on proximity and on one per pass — see the note
   * at `_tickFreeze`'s call site. The freeze sweep edits up to fourteen cells
   * every 1.1s across a 24-cell radius, nearly all of them out of sight, and a
   * voice per cell would be fourteen a second for the whole of winter. What is
   * worth hearing is not "the world is freezing", which is weather, but "the
   * water beside YOU just became something you can stand on", which is a fact
   * about the next step you take.
   *
   * Freezing is the driest sound in this file bar the crab: high, brittle,
   * unpitched grains with one thin rising tone under them. Thawing is the wet
   * opposite — one soft break and two falling bubbles, because melting is water
   * being given back and every rising bubble in this game means air.
   *
   * -48.3 and -47.6, level with each other and a shade under a waterfall at six
   * metres. Loud enough to turn your head at the water's edge, and gated so it
   * only ever happens there.
   */
  ice(freeze = true, pos = null) {
    if (!this._live() || !this._take('block', 1.0)) return;
    const t = this.ctx.currentTime;
    const out = this._dest(pos, 1.1);

    if (freeze) {
      const n = 4 + ((Math.random() * 3) | 0);
      for (let i = 0; i < n; i++) {
        this._noiseHit(out, t + i * (0.04 + Math.random() * 0.07),
          { gain: 0.085, lo: 2200, hi: 5600, q: 8, dur: 0.03, at: 0.001 });
      }
      // Ice sings as it forms, and this thin rising line is the only part of the
      // sound with a pitch at all — which is what stops six dry clicks reading
      // as the crab.
      const o = this.ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(1450, t);
      o.frequency.exponentialRampToValueAtTime(2450 + Math.random() * 500, t + 0.45);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.022, t + 0.10);
      g.gain.exponentialRampToValueAtTime(0.0004, t + 0.45);
      o.connect(g).connect(out);
      o.start(t); o.stop(t + 0.48);
      return;
    }

    // the lid giving: one wet break, low-passed rather than bright
    this._noiseHit(out, t, { gain: 0.11, lo: 220, hi: 1500, q: 1.3, dur: 0.14, at: 0.003 });
    for (let i = 0; i < 2; i++) {
      const tn = t + 0.09 + i * (0.09 + Math.random() * 0.08);
      const bd = 0.10 + Math.random() * 0.06;
      const f = 520 + Math.random() * 260;
      const o = this.ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(f, tn);
      o.frequency.exponentialRampToValueAtTime(f * 0.42, tn + bd);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, tn);
      g.gain.linearRampToValueAtTime(0.055, tn + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0004, tn + bd);
      o.connect(g).connect(out);
      o.start(tn); o.stop(tn + bd + 0.03);
    }
  }

  /**
   * Something is interested in the bait. The quietest world sound in the game
   * at -60.0 — under the menu blip, over a footstep by two dB, and twenty-seven
   * under a nearby thunderclap — and it has to be: the fishing wait is up to a
   * minute of nothing, and the nibble is the one thing that makes staring at a
   * float bearable. Anything louder turns a quiet minute into a metronome.
   *
   * It is not quieter still because it is PANNED and the float is thrown up to
   * ten metres out, where the inverse law takes another eight dB off it. The
   * first cut sat at -65 dry, which is -73 at the end of a real cast: gone.
   *
   * Positional, at the float rather than at the player — you cast it out there,
   * and the whole gesture is that the sound comes from where the line is. The
   * caller throttles it; see `_tickFishing`.
   */
  nibble(pos = null) {
    if (!this._live() || !this._take('block', 0.4)) return;
    const t = this.ctx.currentTime;
    const out = this._dest(pos, 0.5);
    this._noiseHit(out, t, { gain: 0.10, lo: 500, hi: 1800, q: 2.2, dur: 0.055, at: 0.003 });
    // one small bubble, rising — the same trick `splash` uses, at a fifth of it
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    const f = 380 + Math.random() * 240;
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * 2.1, t + 0.07);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.07, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0004, t + 0.08);
    o.connect(g).connect(out);
    o.start(t); o.stop(t + 0.1);
  }

  /**
   * The one that got away. The bite is `splash` — a slap and a run of RISING
   * bubbles — so this is the same water going the other way: a soft swallow and
   * a bloop that falls. Nothing rises in it anywhere, which is the entire tell,
   * and it is why this could not just be `splash` at a lower gain.
   *
   * Positional, at the float. Audible at -47.6 — over a breaking wooden block,
   * under a splash — because it is news, but flat and downward, because it is
   * bad news.
   */
  lineLost(pos = null) {
    if (!this._live() || !this._take('block', 0.8)) return;
    const t = this.ctx.currentTime;
    const d = 0.30;
    const out = this._dest(pos, 0.9);

    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.7 + Math.random() * 0.3;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(1400 + Math.random() * 500, t);
    bp.frequency.exponentialRampToValueAtTime(280, t + d);
    bp.Q.value = 0.9;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.13, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0004, t + d);
    src.connect(bp).connect(g).connect(out);
    src.start(t, Math.random() * 2); src.stop(t + d + 0.05);

    const tn = t + 0.05;
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    const f = 460 * (0.9 + Math.random() * 0.2);
    o.frequency.setValueAtTime(f, tn);
    o.frequency.exponentialRampToValueAtTime(f * 0.30, tn + 0.26);
    const og = this.ctx.createGain();
    og.gain.setValueAtTime(0.0001, tn);
    og.gain.linearRampToValueAtTime(0.11, tn + 0.008);
    og.gain.exponentialRampToValueAtTime(0.0004, tn + 0.28);
    o.connect(og).connect(out);
    o.start(tn); o.stop(tn + 0.30);
  }

  /**
   * A bow with an empty quiver. Deliberately NOT `deny()`: a refusal that fires
   * for a menu purchase, a locked skill and a dry bow teaches the player one
   * thing, which is that something was refused, when the useful thing to learn
   * is which of your two hands is empty of what.
   *
   * So it is the hands rather than the interface — two dull unpitched wooden
   * ticks 45ms apart, the nock finding nothing and the string not moving. Dry,
   * because it is your own bow. -61.5, four dB under the menu blip and one over
   * a footstep: it answers a button you are holding down, and the hint line
   * carries the words.
   *
   * 'ui' budget but the sfx bus, which is not a slip: the category weight is
   * about how many nodes a call builds and this builds four, while the bus is
   * about where the sound lives, and this one lives in the world's mix with the
   * rest of the body rather than up with the menus.
   */
  dryFire() {
    if (!this._live() || !this._take('ui', 0.3)) return;
    const t = this.ctx.currentTime;
    for (let i = 0; i < 2; i++) {
      this._noiseHit(this.sfxBus, t + i * 0.045,
        { gain: 0.35 * (i ? 0.7 : 1), lo: 260, hi: 1100, q: 3, dur: 0.045, at: 0.002 });
    }
  }

  // --- the sky ---------------------------------------------------------------

  /**
   * The turn of the day. `toNight` picks which end.
   *
   * Day and night are not decoration in this game — the husks burn, the spawner
   * opens, the stalker walks, the outdoors-at-night mark counts — and until now
   * the only notice of any of it was the colour of the sky, which you cannot
   * see from inside a mine. This is the one cue that a player underground has
   * any right to.
   *
   * Fired at the MECHANICAL boundary, not the visual one: the caller fires it as
   * `timeOfDay` crosses 0.25 and 0.75, which is the same threshold the husk
   * burn, the spawn grace and `_tickNightOut` all read. A cue for sunset that
   * disagreed with the sunset the rules use would be worse than no cue.
   *
   * Built from the music pad's own palette — low sines, a fifth, a slow swell —
   * so it reads as the world turning rather than as an achievement popping.
   * Nightfall closes downward and hangs; daybreak opens upward and clears. Dry:
   * the sky has no position, for the same reason thunder does not.
   *
   * -43.8 falling and -46.0 rising, either side of the -41 rain bed and well
   * under a nearby animal. Twice a day at most, and in the default clock-synced
   * mode twice a REAL day, so it can afford to be heard.
   */
  sunTurn(toNight = true) {
    if (!this._live() || !this._take('sky', 4)) return;
    const t = this.ctx.currentTime;
    const d = toNight ? 3.4 : 2.7;
    const out = this.sfxBus;
    // 98Hz is G2, which is in the pad's own root set — the two never collide
    // because the pad is a slow drone and this is a shape, but they do agree.
    const root = toNight ? 98 : 110;

    for (const [mul, amt] of [[1, 1], [1.5, 0.55], [3, 0.18]]) {
      const o = this.ctx.createOscillator();
      o.type = mul === 3 ? 'triangle' : 'sine';
      // The gesture, and the only real difference between the two: nightfall
      // sags a whole tone under itself and stays there, daybreak lifts a fourth
      // and opens out. Same three partials, opposite direction.
      o.frequency.setValueAtTime(root * mul * (toNight ? 1 : 0.75), t);
      o.frequency.exponentialRampToValueAtTime(
        root * mul * (toNight ? 0.89 : 1.0), t + d * 0.75,
      );
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.Q.value = 0.7;
      // The filter carries as much of it as the pitch does: dusk closes to 400Hz
      // and dawn opens to 2.2k, which is the difference between a lid coming
      // down and one coming off.
      lp.frequency.setValueAtTime(toNight ? 1600 : 500, t);
      lp.frequency.exponentialRampToValueAtTime(toNight ? 400 : 2200, t + d);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.113 * amt, t + d * (toNight ? 0.35 : 0.22));
      g.gain.exponentialRampToValueAtTime(0.0004, t + d);
      o.connect(lp).connect(g).connect(out);
      if (this.reverbGain) g.connect(this.reverbGain);
      o.start(t); o.stop(t + d + 0.1);
    }
  }

  /**
   * The front of a rain band arriving: a gust that swells and passes.
   *
   * The gap this fills is not that rain has no sound — the bed has always faded
   * in over about seven seconds — it is that the fade has no LEADING edge, so
   * the first you know of a storm is that you are already wet. A gust ahead of
   * the rain is the whole of the warning weather gives in life and it is enough
   * time to get under something.
   *
   * Only for rain and storm arriving. Clear, fair and overcast are silent
   * transitions on purpose: a sound the player can do nothing about, for a state
   * that does nothing to them, is the exact clutter this pass is meant to avoid.
   * Nothing is played when it stops either, for the same reason — a fade that is
   * already happening does not need to be announced.
   *
   * `strength` is 0.6 for rain and 1 for a storm, measuring -48.6 and -43.8.
   * Both sit under the -41 rain bed they precede rather than over it, because a
   * warning that is louder than the weather is just the weather early. The rain
   * front lands level with the wind bed, which is what a gust actually is.
   *
   * On the 'sky' budget at cost 4, not 'weather' at 10 and not 'amb' at 3.
   * Thunder's price would have put a storm's arrival and its first strike at the
   * category cap together, which is the one moment the player most needs their
   * own footsteps to still fit in the budget — and `amb`, which was the first
   * answer, was measured letting four birds drop the storm front. See the note
   * above VOICE_COST.
   *
   * Dry, like thunder: a weather front is the whole sky and panning it would
   * put the storm in one ear.
   */
  squall(strength = 1) {
    if (!this._live() || !this._take('sky', 5)) return;
    const t = this.ctx.currentTime;
    const d = 3.2 + Math.random() * 1.4;
    const out = this.sfxBus;

    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    src.playbackRate.value = 0.55 + Math.random() * 0.3;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 0.85;
    // Rises through the middle and falls away past it: a front passing over,
    // rather than a wind that arrives and stays. The peak is late (0.55 of the
    // way in) so the approach is longer than the departure, which is what makes
    // it read as coming towards you.
    bp.frequency.setValueAtTime(260, t);
    bp.frequency.linearRampToValueAtTime(900 + strength * 500, t + d * 0.55);
    bp.frequency.linearRampToValueAtTime(300, t + d);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.080 * strength, t + d * 0.55);
    g.gain.exponentialRampToValueAtTime(0.0004, t + d);
    src.connect(bp).connect(g).connect(out);
    src.start(t, Math.random() * 2); src.stop(t + d + 0.1);

    // A low body under a storm front only. Rain gets the hiss; a storm gets the
    // pressure as well, and it is the layer that makes the two different sounds
    // rather than one sound at two volumes — the same split the rain bed itself
    // uses (see `rainHiss` / `rainBody` in Ambience).
    if (strength > 0.8) {
      const lo = this.ctx.createBufferSource();
      lo.buffer = this.noiseBuf;
      lo.loop = true;
      lo.playbackRate.value = 0.22;
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 150; lp.Q.value = 0.6;
      const lg = this.ctx.createGain();
      lg.gain.setValueAtTime(0.0001, t);
      lg.gain.linearRampToValueAtTime(0.095, t + d * 0.6);
      lg.gain.exponentialRampToValueAtTime(0.0004, t + d);
      lo.connect(lp).connect(lg).connect(out);
      lo.start(t, Math.random() * 2); lo.stop(t + d + 0.1);
    }
  }

  /**
   * Drawing a bow. `power` is 0..1; the creak climbs with it, so holding at
   * full draw sounds like holding at full draw. Called repeatedly while held —
   * the step budget throttles it if the caller is generous with the rate.
   */
  bowDraw(power = 0.5) {
    if (!this._live() || !this._take('step', 0.35)) return;
    const t = this.ctx.currentTime;
    const d = 0.22;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.35 + Math.random() * 0.2;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(420 + power * 700, t);
    bp.frequency.linearRampToValueAtTime(620 + power * 1200, t + d);
    bp.Q.value = 5;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    // -58 weighted at full draw: three dB under a footstep, for a sound whose
    // whole job is to report how hard the shot will be.
    g.gain.linearRampToValueAtTime(0.13 + power * 0.09, t + 0.06);
    g.gain.exponentialRampToValueAtTime(0.0004, t + d);
    src.connect(bp).connect(g).connect(this.sfxBus);
    src.start(t, Math.random() * 2); src.stop(t + d + 0.05);
  }

  /** Loosing it: string thwip plus the shaft leaving, both scaled by draw. */
  bowRelease(power = 1) {
    if (!this._live() || !this._take('player', 0.6)) return;
    const t = this.ctx.currentTime;
    const p = 0.35 + power * 0.65;

    // string: a fast damped low twang
    const o = this.ctx.createOscillator();
    o.type = 'triangle';
    const f = 150 + power * 130;
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * 0.45, t + 0.11);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.24 * p, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0004, t + 0.13);
    o.connect(g).connect(this.sfxBus);
    o.start(t); o.stop(t + 0.15);

    // shaft: bright noise sweeping down and away
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 1.3;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(3800 + power * 2600, t);
    bp.frequency.exponentialRampToValueAtTime(700, t + 0.28);
    bp.Q.value = 1.3;
    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.linearRampToValueAtTime(0.16 * p, t + 0.006);
    ng.gain.exponentialRampToValueAtTime(0.0004, t + 0.28);
    src.connect(bp).connect(ng).connect(this.sfxBus);
    src.start(t, Math.random() * 2); src.stop(t + 0.32);
  }

  /**
   * A swing that hit nothing. Cheap, and the reason a miss feels different from
   * standing still — the whole point of a whoosh is that it is not a hit.
   */
  swing() {
    if (!this._live() || !this._take('step', 0.3)) return;
    const t = this.ctx.currentTime;
    const d = 0.19;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.9 + Math.random() * 0.3;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(360, t);
    bp.frequency.exponentialRampToValueAtTime(1500 + Math.random() * 700, t + d * 0.45);
    bp.frequency.exponentialRampToValueAtTime(300, t + d);
    bp.Q.value = 1.8;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.10, t + d * 0.35);
    g.gain.exponentialRampToValueAtTime(0.0004, t + d);
    src.connect(bp).connect(g).connect(this.sfxBus);
    src.start(t, Math.random() * 2); src.stop(t + d + 0.03);
  }

  /**
   * An arrow arriving. A hard tick tuned by what it hit, plus a shaft ring on
   * anything that is not flesh. `dig('stone')` stood in for this everywhere,
   * which meant an arrow into a tree sounded like a pickaxe.
   */
  impact(mat = 'wood', pos = null) {
    if (!this._live() || !this._take('hit', 0.5)) return;
    const cfg = MATERIAL_TUNING[mat] || MATERIAL_TUNING.wood;
    const t = this.ctx.currentTime;
    const out = this._dest(pos, 0.6, false);
    this._noiseHit(out, t, { gain: 0.30, lo: cfg.lo, hi: cfg.hi * 1.4, q: 1.0, dur: 0.07 });
    const o = this.ctx.createOscillator();
    o.type = 'triangle';
    const f = Math.max(90, (cfg.body || 240) * 1.4);
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * 0.6, t + 0.16);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.16, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0004, t + 0.18);
    o.connect(g).connect(out);
    o.start(t); o.stop(t + 0.2);
  }

  // --- creatures -------------------------------------------------------------

  /** One-shot noise voice, used for breath, chitter and flesh impacts. */
  _noiseHit(out, t, { gain, lo, hi, q = 1, dur, at = 0.004 }) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.7 + Math.random() * 0.6;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(hi, t);
    bp.frequency.exponentialRampToValueAtTime(Math.max(40, lo), t + dur);
    bp.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + at);
    g.gain.exponentialRampToValueAtTime(0.0004, t + dur);
    src.connect(bp).connect(g).connect(out);
    src.start(t, Math.random() * 2);
    src.stop(t + dur + 0.05);
  }

  /**
   * Species vocalisation. `kind` is 'idle' | 'hurt' | 'death'; `pos` anchors it
   * in the world. Idle calls are rate-limited globally so a herd cannot stack
   * into a wall of noise even if every animal asks at once.
   */
  mob(type, kind = 'idle', pos = null) {
    if (!this._live()) return false;
    const v = MOB_VOICE[type];
    const mode = VOX_MODE[kind] || VOX_MODE.idle;
    if (!v) return false;
    const t = this.ctx.currentTime;
    if (kind === 'idle' && !v.far && !v.urgent) {
      // Hard floor between any two idle calls from any animal. `urgent` species
      // are out of it: the floor is a herd limiter, and a yeti's approach tell
      // being eaten by a rabbit that called 0.3s earlier is the exact failure
      // this table was written to end. There are at most a handful of hostiles
      // alive at once and Mobs' own per-world cooldown still applies to them.
      if (t - this._lastIdleVox < 0.45) { this.stats.throttled++; return false; }
      this._lastIdleVox = t;
    }

    const jitter = 0.9 + Math.random() * 0.22;
    const pitch = mode.pitch * jitter;
    const dur = v.dur * mode.dur * (0.88 + Math.random() * 0.28);
    // A death is the last thing an animal ever does; it outbids a herd of idles
    // for the last slot in the budget rather than being dropped by them. An
    // attack windup outbids them for the same reason and a better one: at
    // VOICE_COST.mob 7 against VOICE_CAP.mob 28 the category holds four
    // concurrent voices, and a paddock idling nearby can hold all four, so
    // without this the one cue a player has to react to is the cue a sheep can
    // delete. Both still TAKE budget when there is any to take — outbidding is
    // about not being refused, not about being unaccounted for.
    const priority = kind === 'death' || kind === 'attack';
    if (!this._take('mob', dur * 2 + 0.4) && !priority) return false;
    const gain = v.gain * mode.gain;
    const out = this._dest(pos, dur * 2 + 0.4, true, !!v.far);
    const f0 = v.base * pitch;

    if (v.kind === 'bleat') {
      // ruminant: sawtooth larynx, heavy vibrato, a nasal formant pair
      const o = this.ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(f0 * 1.10, t);
      o.frequency.linearRampToValueAtTime(f0, t + dur * 0.22);
      o.frequency.exponentialRampToValueAtTime(Math.max(35, f0 * mode.drop), t + dur);
      const lfo = this.ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.setValueAtTime(9 + Math.random() * 5, t);
      lfo.frequency.linearRampToValueAtTime(24 + Math.random() * 10, t + dur);
      const lg = this.ctx.createGain(); lg.gain.value = f0 * 0.11;
      lfo.connect(lg).connect(o.frequency);
      const f1 = this.ctx.createBiquadFilter();
      f1.type = 'bandpass'; f1.frequency.value = 640 * jitter; f1.Q.value = 2.4;
      const f2 = this.ctx.createBiquadFilter();
      f2.type = 'lowpass'; f2.frequency.value = 2600; f2.Q.value = 0.7;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(gain, t + 0.05);
      g.gain.linearRampToValueAtTime(gain * 0.75, t + dur * 0.6);
      g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
      o.connect(f1).connect(f2).connect(g).connect(out);
      o.start(t); o.stop(t + dur + 0.05);
      lfo.start(t); lfo.stop(t + dur + 0.05);
      this._noiseHit(out, t, { gain: gain * 0.16, lo: 400, hi: 1600, q: 0.8, dur: dur * 0.5, at: 0.03 });
    } else if (v.kind === 'squeak') {
      // small mammal: fast up-down glissando, plus a dry chitter
      const grains = kind === 'idle' ? 1 + ((Math.random() * 3) | 0) : 1;
      for (let n = 0; n < grains; n++) {
        const tn = t + n * (0.055 + Math.random() * 0.05);
        const o = this.ctx.createOscillator();
        o.type = 'triangle';
        o.frequency.setValueAtTime(f0 * 0.62, tn);
        o.frequency.exponentialRampToValueAtTime(f0 * 1.7, tn + dur * 0.3);
        o.frequency.exponentialRampToValueAtTime(f0 * mode.drop, tn + dur);
        const hp = this.ctx.createBiquadFilter();
        hp.type = 'highpass'; hp.frequency.value = 420;
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0.0001, tn);
        g.gain.linearRampToValueAtTime(gain * (n === 0 ? 1 : 0.7), tn + 0.006);
        g.gain.exponentialRampToValueAtTime(0.0004, tn + dur);
        o.connect(hp).connect(g).connect(out);
        o.start(tn); o.stop(tn + dur + 0.03);
        this._noiseHit(out, tn, { gain: gain * 0.3, lo: 1800, hi: 5200, q: 1.6, dur: dur * 0.6 });
      }
    } else if (v.kind === 'chime') {
      // Handbells: two or three struck partials per note, a fifth apart, each
      // one a fast attack onto a long exponential tail. Sine partials only —
      // every richer waveform tried here read as a game menu rather than metal.
      const notes = kind === 'idle' ? [1, 1.5, 2] : [1, 1.5];
      for (let n = 0; n < notes.length; n++) {
        const tn = t + n * (0.16 + Math.random() * 0.05);
        const f = f0 * notes[n];
        for (const [mul, amt] of [[1, 1], [2.76, 0.30], [5.4, 0.12]]) {
          const o = this.ctx.createOscillator();
          o.type = 'sine';
          o.frequency.setValueAtTime(f * mul, tn);
          // A struck bell falls slightly flat as it decays; without this the
          // tail sits dead still and sounds synthesised.
          o.frequency.linearRampToValueAtTime(f * mul * 0.995, tn + dur);
          const g = this.ctx.createGain();
          g.gain.setValueAtTime(0.0001, tn);
          g.gain.linearRampToValueAtTime(gain * amt, tn + 0.004);
          g.gain.exponentialRampToValueAtTime(0.0004, tn + dur * (mul > 3 ? 0.35 : 1));
          o.connect(g).connect(out);
          o.start(tn); o.stop(tn + dur + 0.05);
        }
        // the clapper itself, so each note has an edge to it
        this._noiseHit(out, tn, { gain: gain * 0.16, lo: 2200, hi: 8000, q: 1.1, dur: 0.06 });
      }
    } else if (v.kind === 'cluck') {
      // bird: a run of clipped glottal grains, the last one longer and higher
      const grains = kind === 'idle' ? 2 + ((Math.random() * 3) | 0) : 2;
      for (let n = 0; n < grains; n++) {
        const last = n === grains - 1;
        const tn = t + n * (0.085 + Math.random() * 0.06);
        const gd = last ? dur * 0.55 : 0.05 + Math.random() * 0.03;
        const o = this.ctx.createOscillator();
        o.type = 'square';
        const top = f0 * (last ? 1.55 : 1.0) * (0.94 + Math.random() * 0.14);
        o.frequency.setValueAtTime(top, tn);
        o.frequency.exponentialRampToValueAtTime(Math.max(80, top * (last ? 0.42 : 0.55) * mode.drop), tn + gd);
        const bp = this.ctx.createBiquadFilter();
        bp.type = 'bandpass'; bp.frequency.value = 1100 * jitter; bp.Q.value = 1.4;
        const lp = this.ctx.createBiquadFilter();
        lp.type = 'lowpass'; lp.frequency.value = 3200;
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0.0001, tn);
        g.gain.linearRampToValueAtTime(gain * (last ? 1.1 : 0.8), tn + 0.006);
        g.gain.exponentialRampToValueAtTime(0.0004, tn + gd);
        o.connect(bp).connect(lp).connect(g).connect(out);
        o.start(tn); o.stop(tn + gd + 0.03);
        this._noiseHit(out, tn, { gain: gain * 0.22, lo: 700, hi: 2800, q: 1.2, dur: gd * 0.7 });
      }
    } else if (v.kind === 'roar') {
      // Big voiced throat. Three detuned partials into ONE gain that an LFO
      // chews at `rough[1]` Hz, then a pair of peaking filters standing in for
      // a vowel, then the envelope.
      //
      // The chop is the species, not the pitch. Below about 20Hz the ear counts
      // the pulses and hears a bellow; by 30-40Hz it stops counting and hears a
      // rasp; past 50Hz the sidebands land inside the harmonic series and it
      // stops being modulation at all and becomes distortion. Eight species
      // share this branch and they run 5, 6.5, 9, 14, 17, 24, 33 and 61 Hz,
      // which is a wider audible spread than their fundamentals give.
      const rr = v.rough || [0.3, 16];
      const fm = v.form || [500, 1100];
      const atk = Math.max(0.012, dur * (v.swell ?? 0.2));

      const am = this.ctx.createGain();
      am.gain.value = 1 - rr[0] * 0.5;
      const lfo = this.ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = rr[1] * (0.92 + Math.random() * 0.16);
      const lg = this.ctx.createGain(); lg.gain.value = rr[0] * 0.5;
      lfo.connect(lg).connect(am.gain);
      lfo.start(t); lfo.stop(t + dur + 0.1);

      // Peaking rather than bandpass: two bandpasses in series throw away most
      // of the fundamental, which is the part of a roar you feel.
      const p1 = this.ctx.createBiquadFilter();
      p1.type = 'peaking'; p1.frequency.value = fm[0] * jitter;
      p1.Q.value = 1.6; p1.gain.value = 9;
      const p2 = this.ctx.createBiquadFilter();
      p2.type = 'peaking'; p2.frequency.value = fm[1] * jitter;
      p2.Q.value = 1.2; p2.gain.value = 6;
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = fm[1] * 2.6; lp.Q.value = 0.7;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(gain, t + atk);
      g.gain.linearRampToValueAtTime(gain * 0.78, t + dur * 0.78);
      g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
      am.connect(p1).connect(p2).connect(lp).connect(g).connect(out);

      // 1.48 is deliberately not a harmonic. On the harsh voices it beats
      // against the fundamental instead of reinforcing it, which is what makes
      // the demon read as tearing rather than as a low note.
      const parts = v.harsh
        ? [[1, 1, 'sawtooth'], [1.007, 0.8, 'sawtooth'], [1.48, 0.45, 'sawtooth']]
        : [[1, 1, 'sawtooth'], [1.006, 0.7, 'sawtooth'], [0.5, 0.5, 'triangle']];
      for (const [mul, amt, type] of parts) {
        const o = this.ctx.createOscillator();
        o.type = type;
        const f = f0 * mul;
        o.frequency.setValueAtTime(f * (v.rise ? 0.62 : 1.06), t);
        if (v.rise) o.frequency.exponentialRampToValueAtTime(f * v.rise, t + dur * 0.32);
        else o.frequency.linearRampToValueAtTime(f, t + dur * 0.25);
        o.frequency.exponentialRampToValueAtTime(
          Math.max(22, f * (v.rise ? v.rise * 0.85 : 1) * mode.drop), t + dur);
        const og = this.ctx.createGain(); og.gain.value = amt;
        o.connect(og).connect(am);
        o.start(t); o.stop(t + dur + 0.08);
      }

      // The sub goes round the formants rather than through them. Filtered it
      // would be shaped away, and it is the half of a cyclops you feel.
      if (v.sub) {
        const s = this.ctx.createOscillator();
        s.type = 'sine';
        s.frequency.setValueAtTime(f0 * 0.5, t);
        s.frequency.exponentialRampToValueAtTime(Math.max(20, f0 * 0.5 * mode.drop), t + dur);
        const sg = this.ctx.createGain();
        sg.gain.setValueAtTime(0.0001, t);
        sg.gain.linearRampToValueAtTime(gain * v.sub, t + atk);
        sg.gain.exponentialRampToValueAtTime(0.0005, t + dur);
        s.connect(sg).connect(out);
        s.start(t); s.stop(t + dur + 0.08);
      }
      if (v.breath) {
        this._noiseHit(out, t, {
          gain: gain * v.breath, lo: fm[0] * 0.5, hi: fm[1] * 2, q: 0.8,
          dur: dur * 0.9, at: atk,
        });
      }
      // Dragon only: the roar stops and the flame does not. Starts late on
      // purpose, so it is heard as a consequence rather than as brightness.
      if (v.hiss) {
        this._noiseHit(out, t + dur * 0.55, {
          gain: gain * v.hiss, lo: 2200, hi: 6400, q: 0.9, dur: dur * 0.8, at: dur * 0.25,
        });
      }
    } else if (v.kind === 'chitter') {
      // Rhythm-first voices: a run of short grains, and what identifies the
      // species is the count, the spacing and whether each grain rises or
      // falls. The dog is two falling, the monkey three rising, the imp six
      // falling fast, the bat two very high and very short.
      // A hurt and a death are cut short — a run of grains is a statement and
      // an animal that has just been hit does not finish sentences. An ATTACK
      // is not: measured, thinning the bat's two grains to one put its windup
      // 3.9dB UNDER its own idle, which is the tell arriving quieter than the
      // ambient chatter it has to be heard over.
      const gn = kind === 'hurt' || kind === 'death'
        ? Math.max(1, Math.round((v.grains || 3) * 0.6))
        : Math.max(1, v.grains || 3);
      const gap = v.gap || 0.1;
      for (let n = 0; n < gn; n++) {
        const tn = t + n * gap * (0.85 + Math.random() * 0.3);
        const gd = Math.min(dur, gap * 1.5) * (0.8 + Math.random() * 0.4);
        const o = this.ctx.createOscillator();
        o.type = v.wave || 'square';
        const f = f0 * (0.94 + Math.random() * 0.12);
        o.frequency.setValueAtTime(f, tn);
        o.frequency.exponentialRampToValueAtTime(
          Math.max(50, f * (v.glide || 0.7) * mode.drop), tn + gd);
        const bp = this.ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = (v.band || 1200) * jitter; bp.Q.value = 1.3;
        const lp = this.ctx.createBiquadFilter();
        lp.type = 'lowpass'; lp.frequency.value = (v.band || 1200) * 3.2;
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0.0001, tn);
        g.gain.linearRampToValueAtTime(gain * (n === 0 ? 1 : 0.82), tn + 0.005);
        g.gain.exponentialRampToValueAtTime(0.0004, tn + gd);
        o.connect(bp).connect(lp).connect(g).connect(out);
        o.start(tn); o.stop(tn + gd + 0.03);
        // A bark with no air in it is a beep. This is the consonant.
        this._noiseHit(out, tn, {
          gain: gain * 0.28, lo: (v.band || 1200) * 0.5, hi: (v.band || 1200) * 2.4,
          q: 1.2, dur: gd * 0.6,
        });
      }
    } else if (v.kind === 'noisevox') {
      // Unpitched, entirely. Six species share this and none of them can be
      // confused with the tuned ones for the same reason a maraca is never
      // confused with a trumpet, whatever else is playing.
      //
      // `grains` 1 is a sustained band (a breath, a scrape); more than one is a
      // clatter. `trem` cuts the sustained case at an audible rate, which is
      // the whole difference between the giraffe's huff and the prickler's rasp
      // even though both are one band of noise.
      const gn = Math.max(1, v.grains || 1);
      const gd = gn === 1 ? dur : Math.min(dur, (v.gap || 0.06) * 1.1);
      for (let n = 0; n < gn; n++) {
        const tn = t + n * (v.gap || 0.06) * (0.85 + Math.random() * 0.3);
        const src = this.ctx.createBufferSource();
        src.buffer = this.noiseBuf;
        src.playbackRate.value = 0.7 + Math.random() * 0.6;
        const bp = this.ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.setValueAtTime(v.hi * (0.9 + Math.random() * 0.2), tn);
        bp.frequency.exponentialRampToValueAtTime(Math.max(40, v.lo), tn + gd);
        bp.Q.value = v.q || 1;
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0.0001, tn);
        g.gain.linearRampToValueAtTime(gain * (n === 0 ? 1 : 0.85), tn + (v.at ?? 0.004));
        g.gain.exponentialRampToValueAtTime(0.0004, tn + gd);
        if (v.trem) {
          const tl = this.ctx.createOscillator();
          tl.type = 'sine'; tl.frequency.value = v.trem * (0.9 + Math.random() * 0.2);
          const tg = this.ctx.createGain(); tg.gain.value = gain * 0.45;
          tl.connect(tg).connect(g.gain);
          tl.start(tn); tl.stop(tn + gd + 0.05);
        }
        src.connect(bp).connect(g).connect(out);
        src.start(tn, Math.random() * 2); src.stop(tn + gd + 0.05);
      }
      // The sporeling's dull knock. Noise alone gave it no body at all and it
      // vanished behind anything else in the mix.
      if (v.pop) {
        const o = this.ctx.createOscillator();
        o.type = 'sine';
        o.frequency.setValueAtTime(f0, t);
        o.frequency.exponentialRampToValueAtTime(Math.max(30, f0 * 0.45 * mode.drop), t + dur * 0.6);
        const pg = this.ctx.createGain();
        pg.gain.setValueAtTime(0.0001, t);
        pg.gain.linearRampToValueAtTime(gain * v.pop, t + 0.02);
        pg.gain.exponentialRampToValueAtTime(0.0004, t + dur * 0.6);
        o.connect(pg).connect(out);
        o.start(t); o.stop(t + dur * 0.7);
      }
    } else if (v.kind === 'tonal') {
      // Pure tone, no noise layer at all — which is itself the identity. Four
      // species, separated by what the tone DOES: the cat hinges up then down,
      // the ghost swells and falls, the small alien is ring-modulated into
      // inharmonicity, the tall one barely moves and beats against itself.
      const gl = v.glide || [1, 1.2, 0.8];
      const vb = v.vib || [5, 0.04];
      const voices = v.beat ? [0, v.beat] : [0];
      for (const off of voices) {
        const o = this.ctx.createOscillator();
        o.type = v.wave || 'sine';
        o.frequency.setValueAtTime(f0 * gl[0] + off, t);
        o.frequency.exponentialRampToValueAtTime(f0 * gl[1] + off, t + dur * 0.38);
        o.frequency.exponentialRampToValueAtTime(
          Math.max(30, f0 * gl[2] * mode.drop + off), t + dur);
        const lfo = this.ctx.createOscillator();
        lfo.type = 'sine'; lfo.frequency.value = vb[0] * (0.9 + Math.random() * 0.2);
        const lg = this.ctx.createGain(); lg.gain.value = f0 * vb[1];
        lfo.connect(lg).connect(o.frequency);
        lfo.start(t); lfo.stop(t + dur + 0.1);

        let node = o;
        // True ring modulation: a gain resting at zero, driven bipolar. Nothing
        // with a throat can do this, and that is the point of the aliens.
        if (v.ring) {
          const rg = this.ctx.createGain(); rg.gain.value = 0;
          const rm = this.ctx.createOscillator();
          rm.type = 'sine'; rm.frequency.value = v.ring;
          rm.connect(rg.gain);
          rm.start(t); rm.stop(t + dur + 0.1);
          o.connect(rg); node = rg;
        }
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(gain * (off ? 0.8 : 1), t + dur * 0.18);
        g.gain.linearRampToValueAtTime(gain * (off ? 0.6 : 0.75), t + dur * 0.7);
        g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
        if (v.form) {
          const pk = this.ctx.createBiquadFilter();
          pk.type = 'peaking'; pk.frequency.value = v.form * jitter;
          pk.Q.value = 2.0; pk.gain.value = 8;
          node.connect(pk).connect(g).connect(out);
        } else {
          node.connect(g).connect(out);
        }
        o.start(t); o.stop(t + dur + 0.1);
      }
    } else if (v.kind === 'gurgle') {
      // Drowned. A very dark sustained low note with bubbles rising through it,
      // low-passed hard enough that it reads as heard through water even when
      // the player is stood in the air beside it.
      const o = this.ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(f0 * 1.1, t);
      o.frequency.exponentialRampToValueAtTime(Math.max(24, f0 * mode.drop), t + dur);
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 260; lp.Q.value = 1.4;
      const wob = this.ctx.createOscillator();
      wob.type = 'sine'; wob.frequency.value = 3.2 + Math.random() * 1.6;
      const wg = this.ctx.createGain(); wg.gain.value = 90;
      wob.connect(wg).connect(lp.frequency);
      wob.start(t); wob.stop(t + dur + 0.1);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(gain, t + dur * 0.2);
      g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
      o.connect(lp).connect(g).connect(out);
      o.start(t); o.stop(t + dur + 0.08);
      // Rising resonances, the same trick that makes `splash` read as water.
      const bubbles = 4 + ((Math.random() * 4) | 0);
      for (let n = 0; n < bubbles; n++) {
        const tn = t + 0.05 + Math.random() * dur * 0.8;
        const bd = 0.05 + Math.random() * 0.09;
        const bf = 140 + Math.random() * 260;
        const b = this.ctx.createOscillator();
        b.type = 'sine';
        b.frequency.setValueAtTime(bf, tn);
        b.frequency.exponentialRampToValueAtTime(bf * (2 + Math.random() * 1.4), tn + bd);
        const bg = this.ctx.createGain();
        bg.gain.setValueAtTime(0.0001, tn);
        bg.gain.linearRampToValueAtTime(gain * 0.30, tn + 0.006);
        bg.gain.exponentialRampToValueAtTime(0.0004, tn + bd);
        b.connect(bg).connect(out);
        b.start(tn); b.stop(tn + bd + 0.03);
      }
    } else if (v.kind === 'buzz') {
      // The only sustained voice in the table. A band-limited saw chopped at
      // 42Hz, with the fundamental wandering so a hive does not phase-lock into
      // one flat tone.
      const o = this.ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(f0, t);
      o.frequency.linearRampToValueAtTime(f0 * (0.88 + Math.random() * 0.3), t + dur * 0.5);
      o.frequency.linearRampToValueAtTime(f0 * mode.drop, t + dur);
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 620 * jitter; bp.Q.value = 1.1;
      const am = this.ctx.createGain(); am.gain.value = 0.6;
      const lfo = this.ctx.createOscillator();
      lfo.type = 'sine'; lfo.frequency.value = 42 * (0.9 + Math.random() * 0.2);
      const lg = this.ctx.createGain(); lg.gain.value = 0.4;
      lfo.connect(lg).connect(am.gain);
      lfo.start(t); lfo.stop(t + dur + 0.1);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(gain, t + 0.08);
      g.gain.linearRampToValueAtTime(gain * 0.85, t + dur * 0.7);
      g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
      o.connect(bp).connect(am).connect(g).connect(out);
      o.start(t); o.stop(t + dur + 0.08);
    } else if (v.kind === 'bubble') {
      // A fish has no voice, so it is given the only noise it actually makes.
      // Kept at the bottom of the ladder deliberately: the muffle is closed to
      // a few hundred Hz whenever the player is down there to hear it.
      const n = 3 + ((Math.random() * 3) | 0);
      for (let i = 0; i < n; i++) {
        const tn = t + i * (0.05 + Math.random() * 0.08);
        const bd = 0.06 + Math.random() * 0.10;
        const f = f0 * (0.6 + Math.random() * 0.7);
        const o = this.ctx.createOscillator();
        o.type = 'sine';
        o.frequency.setValueAtTime(f, tn);
        o.frequency.exponentialRampToValueAtTime(f * (1.8 + Math.random() * 1.4) * mode.drop, tn + bd);
        const lp = this.ctx.createBiquadFilter();
        lp.type = 'lowpass'; lp.frequency.value = 2200;
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0.0001, tn);
        g.gain.linearRampToValueAtTime(gain * (i === 0 ? 1 : 0.8), tn + 0.005);
        g.gain.exponentialRampToValueAtTime(0.0004, tn + bd);
        o.connect(lp).connect(g).connect(out);
        o.start(tn); o.stop(tn + bd + 0.03);
      }
    } else if (v.kind === 'surge') {
      // Displaced water, not a voice. A low band opening and closing over a
      // falling sub — the sound of a large body moving past you, which is the
      // only honest thing to give a shark.
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      src.playbackRate.value = 0.3 + Math.random() * 0.2;
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(140, t);
      lp.frequency.exponentialRampToValueAtTime(560 + Math.random() * 220, t + dur * 0.45);
      lp.frequency.exponentialRampToValueAtTime(120, t + dur);
      lp.Q.value = 1.2;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(gain, t + dur * 0.4);
      g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
      src.connect(lp).connect(g).connect(out);
      src.start(t, Math.random() * 2); src.stop(t + dur + 0.05);
      const s = this.ctx.createOscillator();
      s.type = 'sine';
      s.frequency.setValueAtTime(f0, t);
      s.frequency.exponentialRampToValueAtTime(Math.max(20, f0 * 0.55 * mode.drop), t + dur);
      const sg = this.ctx.createGain();
      sg.gain.setValueAtTime(0.0001, t);
      sg.gain.linearRampToValueAtTime(gain * 0.55, t + dur * 0.35);
      sg.gain.exponentialRampToValueAtTime(0.0005, t + dur);
      s.connect(sg).connect(out);
      s.start(t); s.stop(t + dur + 0.08);
    } else {
      // browser: long low hum, two detuned partials, slow vibrato, very dark
      for (const [mul, amt, type] of [[1, 1, 'triangle'], [2.01, 0.34, 'sine'], [0.5, 0.5, 'sine']]) {
        const o = this.ctx.createOscillator();
        o.type = type;
        o.frequency.setValueAtTime(f0 * mul * 1.04, t);
        o.frequency.linearRampToValueAtTime(f0 * mul, t + dur * 0.3);
        o.frequency.exponentialRampToValueAtTime(Math.max(20, f0 * mul * mode.drop), t + dur);
        const lfo = this.ctx.createOscillator();
        lfo.frequency.value = 4 + Math.random() * 2.5;
        const lg = this.ctx.createGain(); lg.gain.value = f0 * mul * 0.03;
        lfo.connect(lg).connect(o.frequency);
        const lp = this.ctx.createBiquadFilter();
        lp.type = 'lowpass'; lp.frequency.value = 320; lp.Q.value = 0.9;
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(gain * amt, t + dur * 0.22);
        g.gain.linearRampToValueAtTime(gain * amt * 0.8, t + dur * 0.7);
        g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
        o.connect(lp).connect(g).connect(out);
        o.start(t); o.stop(t + dur + 0.08);
        lfo.start(t); lfo.stop(t + dur + 0.08);
      }
      this._noiseHit(out, t, { gain: gain * 0.10, lo: 180, hi: 700, q: 0.7, dur: dur * 0.8, at: 0.12 });
    }

    if (mode.thump > 0) this.mobHit(pos, mode.thump);
    this.stats.mobCalls++;
    return true;
  }

  /**
   * Soft flesh impact — a damp low thump under a short muffled slap. Nothing
   * like the crisp grass footstep this replaced.
   */
  mobHit(pos = null, amt = 1) {
    if (!this._live() || !this._take('hit', 0.5)) return;
    const t = this.ctx.currentTime;
    const dur = 0.17 + Math.random() * 0.06;
    const out = this._dest(pos, dur * 2 + 0.3, true);

    // body: a fast dropping sine, the "whump"
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    const f0 = 132 * (0.85 + Math.random() * 0.3);
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f0 * 0.42, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.34 * amt, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    o.connect(g).connect(out);
    o.start(t); o.stop(t + dur + 0.05);

    // slap: brief damp noise, low-passed so it reads as soft, not gravelly
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.6 + Math.random() * 0.3;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(1500, t);
    lp.frequency.exponentialRampToValueAtTime(320, t + dur);
    lp.Q.value = 0.6;
    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.linearRampToValueAtTime(0.26 * amt, t + 0.004);
    ng.gain.exponentialRampToValueAtTime(0.0004, t + dur * 0.75);
    src.connect(lp).connect(ng).connect(out);
    src.start(t, Math.random() * 2);
    src.stop(t + dur + 0.05);
  }

  // --- weather ---------------------------------------------------------------

  /**
   * Real thunder: a sharp crack transient over a long, irregular, heavily
   * low-passed rumble. Every roll is randomised — count and spacing of the
   * after-rumbles, cutoff sweep, crack brightness — so repeats never match.
   * Non-positional: it is the whole sky.
   *
   * `near` is 0 for a distant roll and 1 for an overhead crack, and it is now
   * an argument rather than a fresh `Math.random()`. It had to become one: the
   * caller delays the boom behind the flash by how far away the strike is, and
   * a sound that rolls in eight seconds late and then cracks like it is
   * overhead is worse than no delay at all. One roll now decides both the gap
   * and the sound, which is the whole of the relationship. Left random when the
   * caller does not care. An overhead strike measures -33.1 and a distant roll
   * -46.3, so the argument is worth thirteen dB as well as six seconds.
   */
  thunder(strength = 1, near = Math.random()) {
    if (!this._live() || !this._take('weather', 7)) return;
    const t = this.ctx.currentTime;
    const boom = 2.6 + Math.random() * 3.4;     // total decay in seconds
    // Clamped: the caller passes up to 1.2, and an overhead strike at that
    // strength used to schedule a gain of 1.26 on the bus. The compressor
    // caught it, but catching it is not the same as it not happening — a
    // limiter working that hard on the loudest event in the game is what makes
    // a storm sound small instead of frightening.
    const amp = Math.min(0.95, (0.5 + near * 0.42) * strength);
    const out = this.sfxBus;
    this.stats.thunder++;

    // --- rumble bed: noise through a slowly closing low-pass -----------------
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    src.playbackRate.value = 0.18 + Math.random() * 0.16;   // stretched = deeper
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(120 + near * 380, t);
    lp.frequency.exponentialRampToValueAtTime(45 + Math.random() * 40, t + boom);
    lp.Q.value = 0.8;
    const lp2 = this.ctx.createBiquadFilter();
    lp2.type = 'lowpass'; lp2.frequency.value = 900; lp2.Q.value = 0.5;
    const body = this.ctx.createGain();
    body.gain.setValueAtTime(0.0001, t);
    body.gain.linearRampToValueAtTime(amp * 0.8, t + 0.03 + (1 - near) * 0.5);

    // irregular swells inside the decay — this is what stops it sounding like
    // one smooth fade every single time
    let lvl = amp * 0.8;
    let tt = t + 0.2;
    const swells = 2 + ((Math.random() * 4) | 0);
    for (let i = 0; i < swells; i++) {
      const step = (boom / swells) * (0.5 + Math.random());
      const dip = lvl * (0.25 + Math.random() * 0.4);
      body.gain.linearRampToValueAtTime(Math.max(0.001, dip), tt + step * 0.55);
      lvl = dip * (1.15 + Math.random() * 0.9);
      body.gain.linearRampToValueAtTime(Math.max(0.001, Math.min(amp, lvl)), tt + step);
      tt += step;
    }
    body.gain.exponentialRampToValueAtTime(0.0004, t + boom);
    src.connect(lp).connect(lp2).connect(body).connect(out);
    src.start(t, Math.random() * 2);
    src.stop(t + boom + 0.2);

    // --- sub: the pressure you feel rather than hear -------------------------
    const sub = this.ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(48 + Math.random() * 22, t);
    sub.frequency.exponentialRampToValueAtTime(20 + Math.random() * 8, t + boom * 0.7);
    const sg = this.ctx.createGain();
    sg.gain.setValueAtTime(0.0001, t);
    sg.gain.linearRampToValueAtTime(amp * 0.5, t + 0.05);
    sg.gain.exponentialRampToValueAtTime(0.0004, t + boom * 0.8);
    sub.connect(sg).connect(out);
    sub.start(t); sub.stop(t + boom * 0.85);

    // --- crack: bright transient, only when the strike is close --------------
    const crackT = t + (1 - near) * (0.05 + Math.random() * 0.35);
    const cd = 0.10 + Math.random() * 0.16;
    const cs = this.ctx.createBufferSource();
    cs.buffer = this.noiseBuf;
    cs.playbackRate.value = 1.1 + Math.random() * 0.7;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.setValueAtTime(900 + near * 2200, crackT);
    hp.frequency.exponentialRampToValueAtTime(220, crackT + cd);
    const cg = this.ctx.createGain();
    cg.gain.setValueAtTime(0.0001, crackT);
    cg.gain.linearRampToValueAtTime(amp * (0.25 + near * 0.75), crackT + 0.002);
    cg.gain.exponentialRampToValueAtTime(0.0006, crackT + cd);
    cs.connect(hp).connect(cg).connect(out);
    cs.start(crackT, Math.random() * 2);
    cs.stop(crackT + cd + 0.05);

    // a couple of stray slaps just after the crack — the tearing edge
    const slaps = near > 0.4 ? 1 + ((Math.random() * 3) | 0) : 0;
    for (let i = 0; i < slaps; i++) {
      const st = crackT + 0.04 + Math.random() * 0.5;
      const sd = 0.05 + Math.random() * 0.1;
      const s2 = this.ctx.createBufferSource();
      s2.buffer = this.noiseBuf;
      s2.playbackRate.value = 0.7 + Math.random() * 0.8;
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 260 + Math.random() * 900; bp.Q.value = 0.9;
      const g2 = this.ctx.createGain();
      g2.gain.setValueAtTime(0.0001, st);
      g2.gain.linearRampToValueAtTime(amp * (0.12 + Math.random() * 0.2), st + 0.004);
      g2.gain.exponentialRampToValueAtTime(0.0004, st + sd);
      s2.connect(bp).connect(g2).connect(out);
      s2.start(st, Math.random() * 2);
      s2.stop(st + sd + 0.05);
    }
  }

  _startAmbience() {
    this.ambience = new Ambience(
      this.ctx, this.ambBus, this.reverbGain, this.noiseBuf,
      (cat) => this._take(cat, 3),
    );
  }

  /**
   * Called every frame. Only `wind`, `water`, `cave` and `underwater` are
   * required; the rest colour the bed by where and when you are, and a caller
   * that does not know them still gets a working ambience. See the hook list in
   * the module notes for what each extra field wants.
   */
  setAmbience(s) {
    if (!this.ctx) return;
    if (this.ambience) this.ambience.set(s);
    const t = this.ctx.currentTime;
    const under = s.underwater || 0;

    // The muffle. 20kHz is transparent, 420Hz is submerged, and the ramp across
    // is what sells the moment your head goes under rather than the level drop.
    if (Math.abs(under - this._muffle) > 0.01) {
      this._muffle = under;
      const cut = 20000 * Math.pow(420 / 20000, under);
      this.muffle.frequency.setTargetAtTime(cut, t, 0.12);
      // Underwater the reverb send opens up: a hard surface a body-length away
      // in every direction, which is exactly what being in a lake is.
      if (this.reverbGain) {
        this.reverbGain.gain.setTargetAtTime(0.16 + under * 0.30, t, 0.2);
      }
      if (this.musicBus) {
        this.musicBus.gain.setTargetAtTime(this.musicVolume * (1 - under * 0.6), t, 0.6);
      }
      this.master.gain.setTargetAtTime(this.masterVolume * (1 - under * 0.45), t, 0.3);
    }
  }

  _startMusic() {
    this.musicBus = this.ctx.createGain();
    this.musicBus.gain.value = this.musicVolume;
    const rev = this.ctx.createConvolver();
    rev.buffer = this._impulse(4.5, 3.4);
    const wet = this.ctx.createGain(); wet.gain.value = 0.55;
    this.musicBus.connect(this.master);
    this.musicBus.connect(wet).connect(rev).connect(this.master);

    // A lydian-ish palette: warm, wide, never resolves too hard.
    const scale = [0, 2, 4, 7, 9, 11, 14, 16];
    const roots = [55, 61.74, 65.41, 49];
    let chordIndex = 0;

    const voice = (freq, dur, gain, type = 'sine', detune = 0) => {
      const t = this.ctx.currentTime;
      const o = this.ctx.createOscillator();
      o.type = type; o.frequency.value = freq; o.detune.value = detune;
      const f = this.ctx.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = 1400; f.Q.value = 0.6;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(gain, t + dur * 0.35);
      g.gain.linearRampToValueAtTime(0, t + dur);
      o.connect(f).connect(g).connect(this.musicBus);
      o.start(t); o.stop(t + dur + 0.1);
    };

    const tick = () => {
      if (!this.ctx) return;
      const root = roots[chordIndex % roots.length];
      chordIndex++;
      const dur = 11 + Math.random() * 5;
      [0, 2, 4].forEach((si, i) => {
        const semi = scale[si];
        const f = root * Math.pow(2, semi / 12) * (i === 0 ? 2 : 4);
        voice(f, dur, 0.05, 'sine', (Math.random() - 0.5) * 8);
        voice(f * 1.005, dur, 0.03, 'triangle', (Math.random() - 0.5) * 10);
      });
      // occasional bell motif
      if (Math.random() < 0.65) {
        const n = scale[(Math.random() * scale.length) | 0];
        setTimeout(() => voice(root * Math.pow(2, n / 12) * 8, 3.2, 0.035, 'sine'), 2000 + Math.random() * 4000);
      }
      this._musicTimer = setTimeout(tick, dur * 900);
    };
    this._musicTimer = setTimeout(tick, 1500);
  }

  /**
   * Master and music levels, 0..1, straight from the settings sliders. Both are
   * scaled by the current underwater duck rather than overwriting it — setting
   * the raw value here while submerged used to snap the mix back to dry until
   * the next time the player's head crossed the surface.
   *
   * Master at zero also switches the engine off rather than merely turning it
   * down. `_live()` has always gated every voice on `enabled`, but nothing ever
   * wrote that flag, so a player who dragged the slider to the left silently
   * kept paying for the whole graph: at a muted master the game still built a
   * PannerNode, three filters and an envelope per footstep, per block break and
   * per animal call, several times a second, all of it multiplied by a gain of
   * zero on the way out. This is the one control the player has that means
   * "off", so it is the one that says so.
   */
  setVolumes(master, music) {
    this.masterVolume = master;
    this.musicVolume = music;
    this.enabled = master > 0;
    const u = this._muffle || 0;
    if (this.master) this.master.gain.value = master * (1 - u * 0.45);
    if (this.musicBus) this.musicBus.gain.value = music * (1 - u * 0.6);
  }
}
