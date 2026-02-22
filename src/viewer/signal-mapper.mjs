/**
 * Maps LFS signals {v, c, e, dt} to target animation weights for Ellie.
 *
 * Actual GLB animation names (from ellie_animation.glb):
 *   Mouth:  "Ellie Mouth Aa", "Ellie mouth Ee", "Ellie mouth Eh",
 *           "Ellie mouth Oo", "Ellie mouth Uu", "Ellie mouth squeeze",
 *           "Ellie mouth smileclosed", "Ellie mouth smileopen"
 *   Face:   "Ellie face default", "Ellie face excited", "Ellie face awkward",
 *           "Ellie face scared", "Ellie face annoyed", "Ellie face suspicious",
 *           "Ellie face squint"
 *   Eyes:   "Ellie eyemask content", "Ellie eyemask relaxed",
 *           "Ellie eyemask concerned", "Ellie eyemask angry",
 *           "RIG.Ellie_Eyelid_Upper_Close-Open", "RIG.Ellie_Eyebrows_Down"
 *   Body:   "ANI-ellie.idle", "Ellie full cheerful", "Ellie full relaxed"
 */

// LFS viseme codes → Ellie mouth animation name
const VISEME_ANIM = {
  AA: "Ellie Mouth Aa",
  AH: "Ellie Mouth Aa",
  AE: "Ellie Mouth Aa",
  AY: "Ellie Mouth Aa",
  EH: "Ellie mouth Eh",
  ER: "Ellie mouth Eh",
  EE: "Ellie mouth Ee",
  IH: "Ellie mouth Ee",
  IY: "Ellie mouth Ee",
  OO: "Ellie mouth Oo",
  OW: "Ellie mouth Oo",
  AW: "Ellie mouth Oo",
  UH: "Ellie mouth Uu",
  UW: "Ellie mouth Uu",
  PP: "Ellie mouth squeeze",   // bilabial — lips press
  BB: "Ellie mouth squeeze",
  MM: "Ellie mouth squeeze",
  FF: "Ellie mouth Eh",        // labiodental
  VV: "Ellie mouth Eh",
  TH: "Ellie mouth Eh",        // dental
  DH: "Ellie mouth Eh",
  SS: "Ellie mouth Ee",        // alveolar
  ZZ: "Ellie mouth Ee",
  NN: "Ellie Mouth Aa",        // nasal
  DD: "Ellie mouth Ee",
  TT: "Ellie mouth Ee",
  SH: "Ellie mouth Uu",        // post-alveolar
  ZH: "Ellie mouth Uu",
  CH: "Ellie mouth Uu",
  JH: "Ellie mouth Uu",
  KK: "Ellie Mouth Aa",        // velar
  GG: "Ellie Mouth Aa",
  NG: "Ellie Mouth Aa",
  LL: "Ellie mouth Eh",        // liquids
  RR: "Ellie mouth Eh",
  WW: "Ellie mouth Oo",        // labial-velar
  YY: "Ellie mouth Ee",        // palatal
  HH: null,                    // glottal — no shape
  SIL: null,                   // silence
};

const MOUTH_ANIMS = [
  "Ellie Mouth Aa",
  "Ellie mouth Ee",
  "Ellie mouth Eh",
  "Ellie mouth Oo",
  "Ellie mouth Uu",
  "Ellie mouth squeeze",
];

export class SignalMapper {
  constructor() {
    this.blinkCooldown = 0;
    this.ambientBlinkTimer = 3000 + Math.random() * 3000;
  }

  /**
   * Map an LFS signal to a dictionary of { animationName: targetWeight }.
   */
  map(signal, dtFrame = 16) {
    const { v, c = 0.85, e = 0.1, dt = 50 } = signal;
    const targets = {};

    // ── Mouth: viseme → one animation active ──
    const activeAnim = VISEME_ANIM[v] || null;
    for (const m of MOUTH_ANIMS) {
      targets[m] = m === activeAnim ? 0.8 : 0.0;
    }
    // Smile blend from confidence
    targets["Ellie mouth smileclosed"] = c > 0.85 && e < 0.15 ? (c - 0.85) * 3 : 0;

    // ── Expression: confidence/entropy → face + eyemask ──
    const cN = Math.max(0, Math.min(1, c));
    const eN = Math.max(0, Math.min(1, e));

    targets["Ellie eyemask content"] = cN * (1 - eN) * 0.6;
    targets["Ellie eyemask relaxed"] = cN * 0.2;
    targets["Ellie eyemask concerned"] = eN * 0.5;
    targets["Ellie face default"] = (1 - eN) * cN * 0.3;
    targets["Ellie face excited"] = cN > 0.9 && eN < 0.1 ? 0.3 : 0;
    targets["Ellie face awkward"] = eN * (1 - cN) * 0.4;
    targets["Ellie face scared"] = eN > 0.5 ? (eN - 0.5) * 0.6 : 0;

    // Eyebrows: entropy raises brows
    targets["RIG.Ellie_Eyebrows_Down"] = -eN * 0.4; // negative = brows up

    // ── Blink: dt > 400ms or ambient timer ──
    this.blinkCooldown -= dtFrame;
    this.ambientBlinkTimer -= dtFrame;

    let blink = false;
    if (dt > 400 && this.blinkCooldown <= 0) blink = true;
    if (this.ambientBlinkTimer <= 0) {
      blink = true;
      this.ambientBlinkTimer = 3000 + Math.random() * 3000;
    }

    if (blink && this.blinkCooldown <= 0) {
      targets["RIG.Ellie_Eyelid_Upper_Close-Open"] = 1.0;
      this.blinkCooldown = 800;
    } else {
      targets["RIG.Ellie_Eyelid_Upper_Close-Open"] = 0.0;
    }

    // ── Idle: always present as base layer ──
    targets["ANI-ellie.idle"] = 0.4;

    // ── Body: subtle posture from sustained emotion ──
    targets["Ellie full cheerful"] = cN > 0.8 ? (cN - 0.8) * 0.5 : 0;
    targets["Ellie full relaxed"] = cN * (1 - eN) * 0.15;

    return targets;
  }
}
