/**
 * Demo signal generator — produces synthetic LFS signals
 * for testing the viewer without a live gro connection.
 */

// Simplified grapheme-to-viseme table
const DIGRAPHS = {
  th: "TH", sh: "SH", ch: "CH", ee: "EE", oo: "OO",
  ou: "OW", ai: "EH", ea: "EE", ie: "EE", oi: "OW",
  ph: "FF", wh: "WW", ng: "NN", ck: "KK",
};

const CHARS = {
  a: "AA", e: "EH", i: "IH", o: "OW", u: "UH",
  b: "PP", c: "KK", d: "NN", f: "FF", g: "KK",
  h: "SIL", j: "CH", k: "KK", l: "LL", m: "PP",
  n: "NN", p: "PP", q: "KK", r: "RR", s: "SS",
  t: "NN", v: "FF", w: "WW", x: "KK", y: "YY", z: "SS",
};

function textToVisemes(text) {
  const visemes = [];
  const lower = text.toLowerCase();
  let i = 0;
  while (i < lower.length) {
    const ch = lower[i];
    // Punctuation / whitespace → silence
    if (/[\s.,!?;:\-"'()\n]/.test(ch)) {
      visemes.push("SIL");
      i++;
      continue;
    }
    // Try digraph
    if (i + 1 < lower.length) {
      const di = lower.slice(i, i + 2);
      if (DIGRAPHS[di]) {
        visemes.push(DIGRAPHS[di]);
        i += 2;
        continue;
      }
    }
    visemes.push(CHARS[ch] || "SIL");
    i++;
  }
  return visemes;
}

// Demo texts with varied emotion content
const TEXTS = [
  "Hello! I'm Ellie. It's so nice to meet you today.",
  "Hmm, let me think about that for a moment... I'm not entirely sure.",
  "Oh! That's actually really exciting! I love when things come together like that.",
  "I have to be honest, that makes me a little nervous. What if something goes wrong?",
  "You know, the weather today is absolutely beautiful. Just perfect for a walk outside.",
  "Wait... did you say that? I'm confused now. Let me reconsider everything.",
  "Ha! That's a great point. I think you're absolutely right about that.",
];

// State machine
let running = false;
let timer = null;
let broadcastFn = null;

function scheduleSignal(signals, index, resolve) {
  if (!running || index >= signals.length) {
    resolve();
    return;
  }
  const sig = signals[index];
  broadcastFn(sig);
  const delay = sig.v === "SIL" ? sig.dt : 40 + Math.random() * 30;
  timer = setTimeout(() => scheduleSignal(signals, index + 1, resolve), delay);
}

function generateSignalsForText(text, startSeq) {
  const visemes = textToVisemes(text);
  const signals = [];
  let seq = startSeq;

  // Determine sentence-level emotion
  const hasQuestion = text.includes("?");
  const hasExclaim = text.includes("!");
  const hasEllipsis = text.includes("...");

  const baseConfidence = hasQuestion ? 0.65 : hasEllipsis ? 0.55 : hasExclaim ? 0.92 : 0.82;
  const baseEntropy = hasQuestion ? 0.35 : hasEllipsis ? 0.45 : hasExclaim ? 0.08 : 0.12;

  for (let i = 0; i < visemes.length; i++) {
    const v = visemes[i];
    const isSilence = v === "SIL";

    // Vary confidence/entropy within sentence
    const progress = i / visemes.length;
    const jitter = () => (Math.random() - 0.5) * 0.08;

    // Confidence dips mid-sentence, recovers at end
    const sentenceCurve = 1 - 0.15 * Math.sin(progress * Math.PI);
    const c = Math.max(0.1, Math.min(1.0, baseConfidence * sentenceCurve + jitter()));

    // Entropy spikes at punctuation
    const punctSpike = isSilence ? 0.1 : 0;
    const e = Math.max(0, Math.min(1.0, baseEntropy + punctSpike + jitter()));

    // Timing: silence gets longer pauses
    let dt;
    if (isSilence) {
      // Check if this is end-of-sentence silence
      dt = i > 0 && visemes[i - 1] === "SIL" ? 80 : 200 + Math.random() * 300;
    } else {
      dt = 35 + Math.random() * 40;
    }

    signals.push({ v, c: +c.toFixed(2), e: +e.toFixed(2), dt: Math.round(dt), seq: seq++ });
  }

  return signals;
}

async function runLoop() {
  let seq = 0;
  let textIndex = 0;

  while (running) {
    const text = TEXTS[textIndex % TEXTS.length];
    const signals = generateSignalsForText(text, seq);
    seq += signals.length;

    // Emit signals with realistic timing
    await new Promise((resolve) => scheduleSignal(signals, 0, resolve));

    if (!running) break;

    // Pause between sentences — "thinking" state
    const thinkingDuration = 1500 + Math.random() * 2000;
    const thinkingSignals = Math.floor(thinkingDuration / 300);
    for (let i = 0; i < thinkingSignals && running; i++) {
      broadcastFn({
        v: "SIL",
        c: +(0.5 + Math.random() * 0.2).toFixed(2),
        e: +(0.3 + Math.random() * 0.2).toFixed(2),
        dt: 300 + Math.round(Math.random() * 200),
        seq: seq++,
      });
      await new Promise((r) => { timer = setTimeout(r, 300 + Math.random() * 200); });
    }

    textIndex++;
  }
}

export function startDemo(broadcast) {
  if (running) return;
  running = true;
  broadcastFn = broadcast;
  runLoop().catch((err) => console.error("Demo error:", err));
}

export function stopDemo() {
  running = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
