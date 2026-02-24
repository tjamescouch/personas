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
    // Weights must be high (>1) to overcome idle's contribution on shared bones.
    // With idle at 1.0 and face at 3.0: face bones get 3/4 = 75% face influence.
    const activeAnim = VISEME_ANIM[v] || null;
    for (const m of MOUTH_ANIMS) {
      targets[m] = m === activeAnim ? 3.0 : 0.0;
    }
    // Smile blend from confidence
    targets["Ellie mouth smileclosed"] = c > 0.85 && e < 0.15 ? (c - 0.85) * 10 : 0;

    // ── Expression: confidence/entropy → face + eyemask ──
    // Weights boosted ~3-4x so face clips dominate shared bones over idle.
    const cN = Math.max(0, Math.min(1, c));
    const eN = Math.max(0, Math.min(1, e));

    targets["Ellie eyemask content"] = cN * (1 - eN) * 2.0;
    targets["Ellie eyemask relaxed"] = cN * 0.8;
    targets["Ellie eyemask concerned"] = eN * 1.5;
    targets["Ellie face default"] = (1 - eN) * cN * 1.0;
    targets["Ellie face excited"] = cN > 0.9 && eN < 0.1 ? 1.0 : 0;
    targets["Ellie face awkward"] = eN * (1 - cN) * 1.2;
    targets["Ellie face scared"] = eN > 0.5 ? (eN - 0.5) * 2.0 : 0;

    // Eyebrows: entropy raises brows
    targets["RIG.Ellie_Eyebrows_Down"] = eN * 2.0;

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
      targets["RIG.Ellie_Eyelid_Upper_Close-Open"] = 3.0;
      this.blinkCooldown = 800;
    } else {
      targets["RIG.Ellie_Eyelid_Upper_Close-Open"] = 0.0;
    }

    // NOTE: idle NOT included in targets — stays at weight 1.0 set during load.
    // This ensures Head/Neck bones get full idle animation (no bind-pose blending).

    return targets;
  }
}
