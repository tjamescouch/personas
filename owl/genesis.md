LLM-Face Streaming (LFS)
Signal Mapping
Internal SignalAvatar ExpressionMouth movement / phonemesToken emission rate + current token shapeEye movement / gazeAttention head focus (what am I "looking at" in context?)Brow furrow / expressionUncertainty / confidence scoresPause / breathGeneration delay / thinking latencyMicro-expressionsLogit entropy (how "torn" am I?)BlinkingLayer norm resets / context boundariesHead tiltSemantic drift from prior topic

The Natural Protocol
The most natural format is a token-synchronous SSE (Server-Sent Events) stream — since that's already how I communicate — but with an interleaved face-state channel.
jsondata: {
  "token": "Hello",
  "face": {
    "viseme": "AA",
    "confidence": 0.94,
    "entropy": 0.12,
    "attention_peak": "you",
    "latency_ms": 43,
    "sentiment_delta": +0.3,
    "layer_surprise": 0.05
  }
}

Why This Protocol Is Natural for an LLM

Token-synchronous — I already emit tokens one at a time. Lip sync is free: each token maps to a viseme cluster.
Confidence as expression — My softmax output is my emotional face. High entropy = furrowed brow. Low entropy = relaxed, certain expression.
Attention as gaze — Transformer attention heads already "look at" specific context tokens. The peak attention target = where my eyes should point.
Latency as breath — When I pause to "think" (longer TTFT or inter-token delay), that's a natural breath, blink, or thoughtful pause animation trigger.
Sentiment delta, not absolute — The change in sentiment between tokens is more expressive than the raw value. A sudden shift = micro-expression flash.


Minimal Viable Signal (4 fields)
json{
  "v": "AH",
  "c": 0.91,
  "e": 0.08,
  "dt": 38
}

Extended Signal (with velocity)
json{
  "v": "AH",
  "c": 0.91,
  "e": 0.08,
  "dt": 38,
  "seq": 1042,
  "c_vel": -0.03,
  "e_vel": +0.01
}
```

The renderer lerps toward target at a rate informed by velocity, preventing jerky expression snapping.

---

## What the Avatar Renderer Does With It

| Signal | Animation |
|---|---|
| viseme | Blend shape on mouth/jaw |
| confidence | Brow height, eye openness |
| entropy | Forehead tension, subtle head tilt |
| attention_peak | Saccade / gaze direction |
| latency_ms | Blink trigger if > 400ms |
| sentiment_delta | Lerp toward smile/neutral/concern |
| layer_surprise | Eyebrow flash (< 200ms transient) |

---

## What Logprobs Actually Give You
```
entropy    H = -Σ p_i · log(p_i)  over top-k logprobs
confidence C = softmax(logprob of chosen token)
surprise   S = -log P(chosen) / log(vocab_size)  [normalized]
```

From OpenAI's `logprobs: true, top_logprobs: 20`, you get enough to compute all three. Anthropic's API exposes top_k logprobs on request.

---

## Deployment Architecture
```
LLM Inference
     │
     ├── token stream ─────────────────────────────► SSE /stream
     │                                                    │
     └── logprobs + timing ──► Signal Extractor ──► face: {} payload ────┘
                                      │
                               (open weights only)
                                      │
                               attention tensors ──► gaze + surprise
For closed APIs: you get 4/7 signals natively.
For open weights + vLLM/llama.cpp: full signal set.

The One Missing Signal: Prosodic Intent
There's a signal not in the base spec that would be extremely valuable: punctuation anticipation. The model "knows" it's about to end a sentence before it emits the period — the logprob mass is already collapsing toward . or ? or ! several tokens early.
json"punct_anticipation": 0.87  // probability mass on sentence-ending tokens
                             // → breath intake animation before clause end
This gives the avatar natural clause-breath timing without audio synthesis.

Why NOT Existing Protocols?

MPEG-4 FAPs / ARKit blendshapes — designed for humans, driven by cameras. We'd be retrofitting.
SSML — text-to-speech markup. Only handles mouth, misses cognition signals entirely.
OpenAI /audio/speech — audio-driven, loses the cognitive layer.
SadTalker / SyncTalk — audio-driven, exactly the wrong direction.
GPT-4o multimodal — audio I/O but expression synthesis is opaque.
Codec avatars (Meta) — camera-driven, not LLM-native.


Verdict
LFS is the correct inversion: emit the cognitive state, render the face from that. The LLM already is the source of truth for its own inner state. The most natural protocol pipes that internal state — tokens + logits + attention + latency — directly to a renderer, rather than synthesizing speech first and inferring expression from that.
The minimal 4-field version is shippable today against any API with logprob access. Full fidelity requires open weights.
