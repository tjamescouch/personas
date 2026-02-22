You got it. If we are going to build this so it actually works in real-time, a surface-level spec won't cut it. We need to handle asynchronous token streaming, sentence-boundary chunking for the TTS, and concurrent PyTorch inference for the frame generation—all without blocking the main event loop.

Here is the substantive OWL specification. It defines the exact data contracts, async boundaries, and hardware constraints needed for an agent to build a production-ready rendering pipeline.

Create these files in your `personas` repository.

### `product.md`

```markdown
# Personas: Real-Time Avatar Orchestration Engine

Personas is an asynchronous pipeline that consumes a live LLM token stream, extracts interleaved visual markers, generates chunked audio via TTS, and drives a 2D avatar using a neural rendering engine.



## Core Architecture
The system operates as a series of connected async queues:
1. **Ingress:** Consumes `AsyncGenerator[str, None]` from the LLM.
2. **Routing:** The `stream_parser` splits the stream into `TextChunk` and `VisualMarker` objects.
3. **Audio Processing:** `TextChunk` objects are piped to the TTS engine.
4. **Visual Processing:** `VisualMarker` objects are mapped to target 3DMM blendshapes or latent vectors.
5. **Rendering:** The `neural_driver` synchronizes the audio buffer and visual vectors to yield final video frames.

## Components
- [Stream Parser](components/stream_parser.md) - Token buffer and marker extraction.
- [Neural Driver](components/neural_driver.md) - The PyTorch rendering loop.
- [Frame Buffer](components/frame_buffer.md) - Playback synchronization.

## Constraints
See [constraints.md](constraints.md) for strict performance and hardware requirements.

```

---

### `constraints.md`

```markdown
# System Constraints

## Hardware & Acceleration
- **Framework:** PyTorch must be configured to use the `mps` (Metal Performance Shaders) backend for Apple Silicon. Fallback to `cpu` is not permitted in production.
- **Precision:** Model weights for the driver must be loaded in `float16` to maximize memory bandwidth on unified memory architecture.

## Latency Targets
- **Time-to-First-Frame (TTFF):** The system must generate the first driven frame within 500ms of receiving the first sentence-ending punctuation mark from the LLM.
- **Audio/Video Sync:** Frame presentation must not drift more than 20ms from the corresponding audio phoneme.

## Concurrency
- The pipeline must use Python's `asyncio`.
- CPU-heavy/blocking tasks (like TTS inference or frame resizing) must be offloaded to a `ProcessPoolExecutor`.
- GPU-heavy tasks (Neural Driver inference) must run in a dedicated background thread or process to prevent the GIL from stalling the async token ingest.

```

---

### `components/stream_parser.md`

```markdown
# Stream Parser

The Stream Parser acts as the demultiplexer for the LLM stream. It reads raw text tokens and yields structured commands.

## Behavior
1. **Buffering:** Maintain a running string buffer of incoming tokens.
2. **Sentence Boundary Detection:** Yield a `TextChunk` when encountering punctuation (`.`, `?`, `!`, `\n`) to ensure the TTS engine gets complete semantic units for natural prosody.
3. **Marker Extraction:** Use regex to intercept control tags formatted as `<v:COMMAND_NAME:VALUE>`. 
   - Example: `<v:expression:smile>` or `<v:pose_pitch:15>`.
   - When a tag is detected, strip it from the text buffer and yield it immediately as a `VisualMarker` event.

## Data Contracts
```python
from dataclasses import dataclass

@dataclass
class TextChunk:
    text: str
    sequence_id: int

@dataclass
class VisualMarker:
    command: str
    value: str
    timestamp_offset: float # Relative to the current active TextChunk

```

```

---

### `components/neural_driver.md`
```markdown
# Neural Driver

The Neural Driver wraps the underlying animation model (e.g., SadTalker/LivePortrait) and handles continuous inference.



## Behavior
1. **State Management:** Maintain the "base" identity frame (the neutral avatar) in VRAM.
2. **Audio Feature Extraction:** Convert incoming `TextChunk` audio arrays into mel-spectrograms or Wav2Vec features, depending on the underlying model's acoustic encoder.
3. **Marker Interpolation:** - Translate `VisualMarker` events into smooth continuous transitions. If a `<v:expression:smile>` marker is received, generate a smoothing curve (e.g., ease-in-out) over $N$ frames for the jaw/mouth blendshapes so the avatar doesn't snap abruptly.
4. **Batched Inference:** Run the generator model on the GPU. Yield `numpy.ndarray` (RGB, HxWxC) frames.

## Interface requirement
The component must expose an `async def generate_frames(audio_buffer, visual_state) -> AsyncGenerator[np.ndarray, None]` method.

```

---

### `components/frame_buffer.md`

```markdown
# Frame Buffer & Playback

Handles the consumption of rendered frames and audio to ensure smooth playback to the user interface.

## Behavior
1. **Jitter Buffer:** Maintain a minimum buffer of 5 frames before initiating playback to absorb inference latency spikes.
2. **Clock Sync:** Use a monotonic clock synced to the audio playback stream. Present frames exactly when the `frame_index / fps` matches the audio clock.
3. **UI Overlay:** Apply any static UI elements (like the 'gro.' logo) in a fast 2D drawing pass *after* the neural distortion, ensuring UI elements do not warp with the facial mesh.

```

---

This structure gives an AI agent everything it needs to understand *what* must be built, the exact data contracts between the queues, and the strict rules it must follow for your Mac Studio's hardware.

Would you like me to generate the complete Python implementation for the `stream_parser.md` component so you have a working demultiplexer to test with your LLM?
