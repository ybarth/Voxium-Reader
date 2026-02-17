# Voxium Reader: Neural Screen Reader with Synchronized Highlighting

## Project Overview

Voxium Reader is a web-based screen reader application that combines neural text-to-speech (HeadTTS/Kokoro-82M) with libsonic time-stretching to achieve playback speeds of 700–900 words per minute, synchronized with a multi-layer visual speech cursor. It supports importing and reading documents in their original visual formatting alongside a clean plain-text view, with bidirectional annotation synchronization between views.

---

## MCP Servers (Assumed Configured)

### Required

| Server | Purpose |
|---|---|
| **supabase-mcp** | Postgres for all structured data. Supabase Auth for identity. Supabase Storage for documents and audio cache. Supabase Realtime for cross-device sync. pgvector for semantic search. |

| **github-mcp** (`@modelcontextprotocol/server-github`) | Version control the codebase, manage issues, pull references to HeadTTS / libsonic / other dependencies |
| **replicate-mcp** | Run alternative TTS models (Kokoro, Chatterbox, ElevenLabs-compatible endpoints) for voice variety; run vision models for document layout analysis and image description |

### Recommended Additional MCPs

| Server | Purpose |
|---|---|
| **anthropic-mcp** (Claude API) | Document summarization, image/chart description, intelligent text segmentation (clause/sentence/paragraph boundary detection), accessibility descriptions of visual formatting |
| **puppeteer-mcp** or **playwright-mcp** | Headless browser rendering of documents in original format for the visual-fidelity container; screenshot capture for computer-vision-based cursor positioning |
| **filesystem-mcp** (`@modelcontextprotocol/server-filesystem`) | Local file access for imported documents, temp audio cache, WASM binaries |
| **memory-mcp** (`@modelcontextprotocol/server-memory`) | Persist cross-session user preferences, reading history, voice assignments |

---

## Architecture

### High-Level System Diagram

```
┌───────────────────────────────────────────────────────────────────────┐
│                         Voxium Reader Client                          │
│                                                                       │
│  ┌────────────┐  ┌──────────────┐  ┌──────────────────────────┐      │
│  │  Document   │  │  Plain Text  │  │   Original Format View   │      │
│  │  Importer   │  │    View      │  │   (Rendered Container)   │      │
│  │  + OCR      │  └──────┬───────┘  └────────────┬─────────────┘      │
│  └─────┬──────┘         │                        │                    │
│        │                ▼                        ▼                    │
│        ▼         ┌─────────────────────────────────────────────────┐  │
│  ┌───────────┐   │              Document Model (Unified AST)       │  │
│  │ Tesseract │   │  ─ Text, formatting, structure, bounding boxes  │  │
│  │ + Cloud   │──→│  ─ Plain-text offsets ↔ original-format rects   │  │
│  │ Vision    │   │  ─ Annotations and highlights in both views     │  │
│  └───────────┘   └─────────────────────────┬───────────────────────┘  │
│                                            │                          │
│  ┌─────────────────────────────────────────┴───────────────────────┐  │
│  │                    Speech Engine Pipeline                        │  │
│  │                                                                  │  │
│  │  ┌──────────┐  ┌──────────┐  ┌───────────┐  ┌───────────┐      │  │
│  │  │ Text     │→ │ HeadTTS  │→ │ libsonic  │→ │ Web Audio │      │  │
│  │  │ Segmenter│  │ (Kokoro) │  │ (WASM)    │  │ Playback  │      │  │
│  │  └──────────┘  └──────────┘  └─────┬─────┘  └─────┬─────┘      │  │
│  │       │              │             │               │            │  │
│  │       │         Word Timings   Simulated       Audio Stream     │  │
│  │       │         + Phonemes     Ground-Truth                     │  │
│  │       │                        Timings                          │  │
│  └────────────────────────────────────┬───────────────┬────────────┘  │
│                                       │               │               │
│  ┌────────────────────────────────────┴───────────────┴────────────┐  │
│  │              Playback Awareness Layer                            │  │
│  │                                                                  │  │
│  │  ┌──────────────────┐  ┌─────────────┐  ┌───────────────────┐  │  │
│  │  │ AudioWorklet     │→ │ Reading     │→ │ Predictive        │  │  │
│  │  │ Boundary Emitter │  │ Position    │  │ Highlight         │  │  │
│  │  │ (audio thread)   │  │ State       │  │ Scheduler         │  │  │
│  │  │                  │  │ Machine     │  │ (pre-schedule +   │  │  │
│  │  │ Fires events at  │  │ (canonical  │  │  drift correction) │  │  │
│  │  │ audio-clock      │  │  source of  │  │                   │  │  │
│  │  │ precision        │  │  truth)     │  │                   │  │  │
│  │  └──────────────────┘  └──────┬──────┘  └───────────────────┘  │  │
│  └───────────────────────────────┼────────────────────────────────┘  │
│                                  │                                    │
│  ┌───────────────────────────────┴────────────────────────────────┐  │
│  │              Multi-Layer Highlighting Engine                    │  │
│  │  ─ Word layer (current word)          ← driven by boundary     │  │
│  │  ─ Clause layer                         events, not polling    │  │
│  │  ─ Sentence layer                                              │  │
│  │  ─ Paragraph layer                                             │  │
│  │  ─ Page/section layer                                          │  │
│  └────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────┘
         │                    │                    │
         ▼                    ▼                    ▼
   ┌──────────┐       ┌────────────┐       ┌────────────┐
   │ Supabase │       │ Supabase   │       │ Replicate  │
   │ Storage  │       │  Postgres  │       │ (alt TTS,  │
   │  (cache) │       │ + pgvector │       │  vision)   │
   └──────────┘       └────────────┘       └────────────┘
```

---

## Core Systems

### 1. Document Importer and Unified AST

**Supported formats:** PDF, EPUB, RTF, DOCX, DAISY, HTML, plain text, scanned images (TIFF, PNG, JPEG via OCR).

The importer produces a **Unified Document AST** — a tree structure that preserves both the logical text flow and the visual formatting:

```typescript
interface DocumentNode {
  id: string;
  type: 'document' | 'section' | 'heading' | 'paragraph' | 'sentence'
        | 'clause' | 'word' | 'image' | 'table' | 'list' | 'footnote';
  text?: string;                    // Plain text content (leaf nodes)
  children?: DocumentNode[];
  formatting: FormattingInfo;       // Font, size, weight, color, style
  boundingBoxes?: BoundingBox[];    // Position in original-format render
  plainTextRange: [number, number]; // Character offsets in flat text
  annotations: Annotation[];
  attributes: Record<string, any>; // Heading level, list depth, etc.
}

interface FormattingInfo {
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: 'normal' | 'bold';
  fontStyle?: 'normal' | 'italic';
  color?: string;
  backgroundColor?: string;
  textDecoration?: string;
  customAttributes?: string[];     // "code", "blockquote", "caption", etc.
}

interface BoundingBox {
  page: number;
  x: number; y: number;
  width: number; height: number;
}
```

**Key design decision:** Every node in the AST carries both a `plainTextRange` (for the clean-text view) and `boundingBoxes` (for the original-format view). This dual mapping is what makes synchronized highlighting and annotation work across both views.

**Parsing pipeline:**
1. **PDF** → pdf.js for text extraction + Replicate/Claude vision model for layout analysis. Vision model identifies columns, sidebars, captions, headers/footers, and reading order.
2. **EPUB** → Parse XHTML chapters directly into AST nodes.
3. **DOCX** → mammoth.js for structural extraction, preserving styles.
4. **RTF** → rtf-parser, mapping RTF formatting codes to FormattingInfo.
5. **DAISY** → Parse NCC/OPF navigation and SMIL sync points; map to AST with pre-existing timing data.
6. **HTML** → Direct DOM parse with computed style capture.
7. **Scanned images / image-only PDFs** → OCR pipeline (see §1b).

#### 1b. OCR Pipeline

Scanned documents and image-only PDFs are detected automatically (a PDF page with no extractable text but with image content triggers OCR). The OCR pipeline produces the same AST structure as text-native documents, including bounding boxes for every word.

```typescript
interface OCRResult {
  pages: OCRPage[];
}

interface OCRPage {
  pageNumber: number;
  blocks: OCRBlock[];      // Paragraphs / regions
  confidence: number;       // Overall page confidence 0-1
  language: string;         // Detected language
}

interface OCRBlock {
  text: string;
  words: OCRWord[];
  boundingBox: BoundingBox;
  blockType: 'text' | 'table' | 'header' | 'footer' | 'caption';
}

interface OCRWord {
  text: string;
  confidence: number;
  boundingBox: BoundingBox;  // Pixel-precise word position
}
```

**OCR engine strategy:**
1. **Primary: Tesseract.js (client-side WASM)**. Runs in a Web Worker. Supports 100+ languages. Returns word-level bounding boxes natively, which map directly to the AST's `boundingBoxes` field.
2. **Fallback for low-confidence pages: Claude API vision.** Upload the page image to Supabase Storage, send to Claude for OCR. Higher accuracy for degraded scans, handwriting, and complex scripts.
3. **Post-OCR correction: Claude API** (via anthropic-mcp). Send the raw OCR text alongside the page image. Claude corrects OCR errors using visual context — especially useful for ligatures, diacritics, tables, and mathematical notation.

**Reading order for complex layouts:**
Scanned documents often have multi-column layouts, sidebars, captions, and footnotes where reading order is ambiguous. After OCR extracts the text blocks with positions, a vision model (Claude or Replicate) analyzes the full page image to determine the correct reading sequence:

```typescript
async function determineReadingOrder(
  pageImage: ImageData,
  ocrBlocks: OCRBlock[]
): Promise<OCRBlock[]> {
  const result = await anthropicMCP.analyze({
    image: pageImage,
    prompt: `This is a scanned document page. The OCR system detected
             ${ocrBlocks.length} text blocks at the following positions:
             ${JSON.stringify(ocrBlocks.map(b => ({
               text: b.text.substring(0, 50),
               position: b.boundingBox
             })))}
             
             Determine the correct reading order for these blocks.
             Consider: columns flow top-to-bottom then left-to-right,
             sidebars and captions are read after the main text they
             relate to, headers/footers are separate.
             Return the block indices in reading order as a JSON array.`
  });
  
  const order = JSON.parse(result);
  return order.map((i: number) => ocrBlocks[i]);
}
```

**OCR results are cached in Supabase Postgres** keyed by document hash + page number, so re-opening a scanned document doesn't re-run OCR.

### 2. Speech Engine Pipeline

The pipeline is a **block-based pre-generation system**, not a real-time streamer. This is fundamental to the design.

#### 2a. Text Segmenter

The segmenter divides the document into **speech blocks** — units that are synthesized, time-stretched, and cached as discrete audio chunks.

```typescript
interface SpeechBlock {
  id: string;
  text: string;                        // Raw text to synthesize
  astNodeIds: string[];                // Which AST nodes this block covers
  plainTextRange: [number, number];
  voiceId: string;                     // Determined by voice-mapping rules
  priority: 'immediate' | 'prefetch' | 'background';
  status: 'pending' | 'synthesizing' | 'stretching' | 'ready' | 'error';
  audioBuffer?: Float32Array;
  wordTimings?: WordTiming[];          // Post-stretch timings
  duration?: number;                   // In milliseconds
}

interface WordTiming {
  word: string;
  startMs: number;     // Within this block's audio
  durationMs: number;
  astNodeId: string;   // Maps back to the exact AST word node
}
```

**Block sizing heuristic:** Each block is approximately one paragraph or 200-400 words, whichever is shorter. Heading nodes always start a new block. Voice changes always start a new block.

#### 2b. HeadTTS Integration (Kokoro-82M)

HeadTTS (`@met4citizen/headtts`) is the primary synthesis engine. It returns word-level timing data alongside audio:

```typescript
// HeadTTS output structure
interface HeadTTSOutput {
  audio: Float32Array;           // Raw PCM at 24kHz
  words: string[];               // Word tokens
  wtimes: number[];              // Word start times in ms
  wdurations: number[];          // Word durations in ms
  phonemes: string[];
  ptimes: number[];
  pdurations: number[];
  visemes: string[];             // For future lip-sync/avatar features
  vtimes: number[];
  vdurations: number[];
}
```

**Execution modes:**
- **Browser (preferred):** WebGPU/WASM inference via onnxruntime-web. Fastest on modern hardware.
- **Node.js server fallback:** CPU inference for devices without WebGPU. Slower but functional.
- **Replicate API fallback:** For alternative voices not available in Kokoro (ElevenLabs, Chatterbox, etc.). These return audio without word timings — forced alignment is required (see §2d).

#### 2c. Libsonic Time-Stretching (WASM)

Libsonic is compiled to WebAssembly for in-browser use. It is specifically optimized for speech speed-ups beyond 2x, which is exactly what we need for 700-900 WPM.

**Compilation approach:**
```bash
# Compile libsonic to WASM using Emscripten
emcc sonic.c -o sonic.js \
  -s EXPORTED_FUNCTIONS='["_sonicCreateStream","_sonicDestroyStream", \
    "_sonicSetSpeed","_sonicSetPitch","_sonicSetRate","_sonicSetVolume", \
    "_sonicWriteShortToStream","_sonicReadShortFromStream", \
    "_sonicFlushStream","_sonicSetSampleRate","_sonicSetNumChannels"]' \
  -s EXPORTED_RUNTIME_METHODS='["cwrap","getValue","setValue"]' \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s MODULARIZE=1 \
  -O3
```

**Timing via Simulation, Not Estimation:**

A fundamental design principle of Voxium Reader: **we never estimate how long it takes to read a chunk of text at a given speed. We simulate it.**

Libsonic is a non-linear algorithm. At extreme speeds (4-6x), it doesn't simply divide every duration by the speed factor uniformly. It makes pitch-period-level decisions about which audio segments to overlap, skip, or retain. The actual output duration of a time-stretched block depends on the audio content — voiced vs. unvoiced segments, pitch period lengths, silence gaps. Two blocks with the same word count and the same speed factor can produce different output durations.

Therefore, the system runs libsonic on each block and **measures the actual output** to determine real timings:

```typescript
interface SimulatedTimings {
  blockDurationMs: number;         // Actual duration of stretched audio
  wordTimings: WordTiming[];       // Measured, not calculated
  simulationSpeedFactor: number;   // The speed this was simulated at
}

async function simulateStretch(
  rawAudio: Float32Array,
  originalTimings: WordTiming[],
  speedFactor: number,
  sampleRate: number
): Promise<SimulatedTimings> {
  // 1. Run libsonic on the actual audio
  const stretchedAudio = await libsonic.stretch(rawAudio, speedFactor);
  const blockDurationMs = (stretchedAudio.length / sampleRate) * 1000;

  // 2. To get precise word boundaries in the stretched audio,
  //    we run libsonic on each word's audio segment individually
  //    and measure the actual output length.
  const wordTimings: WordTiming[] = [];
  let cumulativeMs = 0;

  for (const original of originalTimings) {
    // Extract this word's audio segment from the raw (unstretched) buffer
    const startSample = Math.floor(original.startMs * sampleRate / 1000);
    const endSample = Math.floor(
      (original.startMs + original.durationMs) * sampleRate / 1000
    );
    const wordAudio = rawAudio.slice(startSample, endSample);

    // Stretch this segment and measure the actual output length
    const stretchedWord = await libsonic.stretch(wordAudio, speedFactor);
    const actualDurationMs = (stretchedWord.length / sampleRate) * 1000;

    wordTimings.push({
      ...original,
      startMs: cumulativeMs,
      durationMs: actualDurationMs,
    });

    cumulativeMs += actualDurationMs;
  }

  // 3. Also measure inter-word gaps (silences between words).
  //    Libsonic compresses silences more aggressively than voiced
  //    segments, so gap durations are not proportional either.
  //    The per-word simulation above captures this naturally because
  //    each word segment includes its trailing silence up to the
  //    next word's start.

  return { blockDurationMs, wordTimings, simulationSpeedFactor: speedFactor };
}
```

**Optimization: full-block simulation with marker tracking.**

The per-word approach above is conceptually clean but involves many small libsonic calls. The optimized version runs libsonic once on the full block and tracks sample-count markers:

```typescript
async function simulateStretchOptimized(
  rawAudio: Float32Array,
  originalTimings: WordTiming[],
  speedFactor: number,
  sampleRate: number
): Promise<SimulatedTimings> {
  // Create a libsonic stream
  const stream = libsonic.createStream(sampleRate, 1);
  libsonic.setSpeed(stream, speedFactor);

  // Feed audio in chunks aligned to word boundaries.
  // After feeding each word's samples, flush and count output samples.
  const wordTimings: WordTiming[] = [];
  let totalOutputSamples = 0;

  for (let i = 0; i < originalTimings.length; i++) {
    const current = originalTimings[i];
    const next = originalTimings[i + 1];

    // Determine this word's sample range (including trailing gap)
    const startSample = Math.floor(current.startMs * sampleRate / 1000);
    const endSample = next
      ? Math.floor(next.startMs * sampleRate / 1000)
      : rawAudio.length;

    const wordSamples = rawAudio.slice(startSample, endSample);
    const outputBefore = totalOutputSamples;

    // Write this word's audio into the sonic stream
    libsonic.writeToStream(stream, wordSamples);

    // Read all available output
    const outputChunk = libsonic.readFromStream(stream);
    totalOutputSamples += outputChunk.length;

    const startMs = (outputBefore / sampleRate) * 1000;
    const durationMs = (outputChunk.length / sampleRate) * 1000;

    wordTimings.push({
      ...current,
      startMs,
      durationMs,
    });
  }

  // Flush remaining audio
  libsonic.flushStream(stream);
  const remaining = libsonic.readFromStream(stream);
  totalOutputSamples += remaining.length;

  // Adjust last word to include flushed tail
  if (wordTimings.length > 0) {
    wordTimings[wordTimings.length - 1].durationMs +=
      (remaining.length / sampleRate) * 1000;
  }

  libsonic.destroyStream(stream);

  return {
    blockDurationMs: (totalOutputSamples / sampleRate) * 1000,
    wordTimings,
    simulationSpeedFactor: speedFactor,
  };
}
```

**This runs in a Web Worker** so it doesn't block the main thread. On modern hardware, libsonic processes a 9-hour audio file in ~50 seconds — so simulating a single paragraph block takes single-digit milliseconds. The simulation cost is negligible.

**When speed changes:** Every cached block must be re-simulated. But because libsonic is so fast, re-simulating 5-10 prefetched blocks takes <100ms total. The system re-simulates the current block first (instant), begins playback, and re-simulates adjacent blocks in background.

**Speed tiers and strategy:**

| Target WPM | Speed Factor | Strategy |
|---|---|---|
| 150-300 | 1x-2x | HeadTTS at native rate → libsonic stretch + simulation |
| 300-500 | 2x-3.3x | HeadTTS at native rate → libsonic stretch + simulation |
| 500-700 | 3.3x-4.7x | HeadTTS at native rate → libsonic stretch + simulation |
| 700-900 | 4.7x-6x | HeadTTS at native rate → libsonic stretch + simulation (libsonic's optimized range) |

All speed tiers use the same pipeline. The simulation produces ground-truth timings at every tier. Libsonic is specifically optimized for the 2x-6x range.

#### 2d. Forced Alignment for Non-Kokoro Voices

When using Replicate-hosted models (ElevenLabs, Chatterbox, etc.) that return audio without word timings, we need forced alignment:

```typescript
// Use Whisper or wav2vec2 for forced alignment
async function forceAlign(
  audio: Float32Array,
  transcript: string,
  sampleRate: number
): Promise<WordTiming[]> {
  // Option 1: Replicate-hosted Whisper with word timestamps
  // Option 2: Client-side whisper.cpp WASM
  // Option 3: Claude API to analyze spectrogram + transcript
}
```

**Preferred approach:** Use Replicate's Whisper endpoint with `word_timestamps=true` on the generated audio. The transcript is already known, so alignment is high-confidence.

### 3. Block Buffer System

The buffer system is the key architectural innovation. Instead of streaming audio in real-time, Voxium Reader pre-generates and caches audio blocks.

```typescript
class BlockBufferManager {
  private blocks: Map<string, SpeechBlock> = new Map();
  private generationQueue: PriorityQueue<SpeechBlock>;
  private currentBlockId: string;
  private currentPositionMs: number;

  // When a document loads or cursor moves:
  async onCursorMove(newPosition: number) {
    const targetBlock = this.findBlockAtPosition(newPosition);
    this.currentBlockId = targetBlock.id;

    // Priority 1: Generate the current block immediately
    await this.generateBlock(targetBlock, 'immediate');

    // Priority 2: Pre-generate the next N blocks outward
    const adjacentBlocks = this.getBlocksOutward(targetBlock, 5);
    for (const block of adjacentBlocks) {
      this.enqueueGeneration(block, 'prefetch');
    }

    // Priority 3: Background-generate remaining document
    const remainingBlocks = this.getRemainingBlocks(targetBlock);
    for (const block of remainingBlocks) {
      this.enqueueGeneration(block, 'background');
    }
  }

  // When speed changes:
  async onSpeedChange(newSpeed: number) {
    // Only need to re-run libsonic + re-simulate, not re-synthesize.
    // HeadTTS audio cache is speed-independent.
    // Re-simulate current block first for instant playback resume.
    const currentBlock = this.blocks.get(this.currentBlockId);
    if (currentBlock?.status === 'ready') {
      const sim = await simulateStretchOptimized(
        currentBlock.rawAudio, currentBlock.rawTimings, newSpeed, 24000
      );
      currentBlock.audioBuffer = await this.libsonic.stretch(
        currentBlock.rawAudio, newSpeed
      );
      currentBlock.wordTimings = sim.wordTimings;
      currentBlock.duration = sim.blockDurationMs;
    }

    // Re-simulate remaining blocks in background worker
    for (const [id, block] of this.blocks) {
      if (id !== this.currentBlockId && block.status === 'ready') {
        this.enqueueResimulation(block, newSpeed);
      }
    }
  }

  private async generateBlock(block: SpeechBlock, priority: string) {
    block.status = 'synthesizing';

    // 1. Synthesize with HeadTTS
    const ttsOutput = await this.headtts.synthesize(block.text, block.voiceId);

    // 2. Cache raw (unstretched) audio and timings
    block.rawAudio = ttsOutput.audio;
    block.rawTimings = this.mapTimingsToAST(ttsOutput, block);

    // 3. Time-stretch with libsonic AND simulate to get real timings
    block.status = 'stretching';
    block.audioBuffer = await this.libsonic.stretch(
      ttsOutput.audio, this.currentSpeed
    );

    // 4. SIMULATE: Run libsonic word-by-word to measure actual
    //    output durations. Never estimate. Always measure.
    const simulation = await simulateStretchOptimized(
      ttsOutput.audio, block.rawTimings, this.currentSpeed, 24000
    );
    block.wordTimings = simulation.wordTimings;
    block.duration = simulation.blockDurationMs;

    // 5. Cache raw audio + raw timings to GCS (speed-independent).
    //    Simulated timings are speed-dependent and regenerated on demand.
    await this.cacheToGCS(block);

    block.status = 'ready';
  }
}
```

**Why blocks, not streaming:**
1. **Speed changes are instant.** Re-stretching + re-simulating cached audio with libsonic is trivially fast — no re-synthesis needed.
2. **Simulation is per-block.** Each block gets its own ground-truth timing simulation. Block-level granularity means simulations are <5ms each.
3. **Cursor jumps are responsive.** The current block is generated and simulated immediately; adjacent blocks prefetch in background.
4. **GCS caching works.** Blocks can be stored in GCS keyed by (document_hash, block_id, voice_id). The time-stretch + simulation happens client-side, so cached audio is speed-independent.
5. **Voice-per-attribute mapping works.** Each block knows its voice before generation. Different formatting → different voice → different blocks.

### 4. Multi-Layer Highlighting Engine

The highlighting system renders concentric layers of emphasis around the current reading position:

```typescript
interface HighlightLayer {
  level: 'word' | 'clause' | 'sentence' | 'paragraph' | 'page';
  color: string;            // User-configurable
  opacity: number;          // Decreasing for outer layers
  borderStyle?: string;
  active: boolean;          // User can toggle each layer
}

// Default configuration
const DEFAULT_LAYERS: HighlightLayer[] = [
  { level: 'word',      color: '#FFD700', opacity: 0.8, active: true },
  { level: 'clause',    color: '#87CEEB', opacity: 0.3, active: true },
  { level: 'sentence',  color: '#90EE90', opacity: 0.15, active: true },
  { level: 'paragraph', color: '#DDA0DD', opacity: 0.08, active: true },
  { level: 'page',      color: '#F0F0F0', opacity: 0.04, active: false },
];
```

**How the speech cursor drives highlighting:**

The highlighting engine does **not** poll for the current playback position. It is driven by the Playback Awareness Layer (§4a below), which emits authoritative boundary-crossing events from the audio thread. See §4a for the full architecture.

1. The Playback Awareness Layer fires a `boundary` event each time the audio clock crosses a word, clause, sentence, paragraph, or page/section boundary.
2. The `ReadingPositionStateMachine` (§4a) updates its canonical state.
3. The highlighting engine reads from the state machine and transitions each layer's visual highlight accordingly.
4. Each layer's highlight rect(s) are computed:
   - **Plain-text view:** Character offset ranges → CSS `::highlight` or absolutely-positioned overlays.
   - **Original-format view:** Bounding boxes from the AST → SVG or Canvas overlay on top of the rendered document.

**Clause detection:** Uses Claude API (via anthropic-mcp) for intelligent clause boundary detection during document import. Falls back to punctuation-based heuristics (commas, semicolons, colons, em-dashes) for offline use.

### 4a. Playback Awareness Layer

This is the infrastructure that ensures the system **genuinely knows** what it is reading at any given moment — not approximately, not by estimation, but by direct observation of the audio clock. At 900 WPM each word lasts ~65ms on average. A polling approach from the main thread (e.g. `requestAnimationFrame` at 60fps / 16ms intervals) can miss word boundaries entirely during GC pauses, React re-renders, or DOM highlight updates. The audio keeps playing in the Web Audio rendering thread regardless of main-thread jank, so any polling-based approach risks the user hearing word 12 while seeing word 10 highlighted.

The Playback Awareness Layer solves this with three components:

#### Component 1: AudioWorklet Boundary Emitter

An `AudioWorkletProcessor` runs in the Web Audio rendering thread, which operates on a dedicated high-priority thread at audio-clock precision (~2.67ms callback intervals at 48kHz / 128-sample frames). It does not share the main thread's event loop and is immune to GC pauses, DOM work, and React renders.

The emitter receives the full simulated timing array for the current block. As audio samples flow through the worklet, it counts samples and posts a message to the main thread the instant each boundary is crossed:

```typescript
// boundary-emitter.worklet.ts
// Runs in the Web Audio rendering thread — NOT the main thread.

interface BoundaryEvent {
  type: 'word' | 'clause' | 'sentence' | 'paragraph' | 'page' | 'block_end';
  astNodeId: string;
  blockId: string;
  indexInBlock: number;      // Which word within this block
  audioTimestampMs: number;  // Exact audio-clock time of crossing
}

interface TimingEntry {
  sampleOffset: number;      // Absolute sample index where this word starts
  astNodeId: string;
  boundaries: string[];      // Which boundaries this word starts: ['word'] or
                             // ['word','sentence','paragraph'] etc.
}

class BoundaryEmitterProcessor extends AudioWorkletProcessor {
  private timings: TimingEntry[] = [];
  private currentIndex: number = 0;
  private sampleCounter: number = 0;
  private blockId: string = '';
  private active: boolean = false;

  constructor() {
    super();
    this.port.onmessage = (e) => {
      switch (e.data.command) {
        case 'loadTimings':
          // Receive pre-computed timing array for a block.
          // Sample offsets are derived from the simulated word timings:
          //   sampleOffset = Math.round(wordTiming.startMs * sampleRate / 1000)
          this.timings = e.data.timings;
          this.blockId = e.data.blockId;
          this.currentIndex = 0;
          this.sampleCounter = 0;
          this.active = true;
          break;

        case 'seek':
          // Jump to a specific sample position (e.g., after cursor move)
          this.sampleCounter = e.data.sampleOffset;
          this.currentIndex = this.findIndexAtSample(e.data.sampleOffset);
          break;

        case 'stop':
          this.active = false;
          break;
      }
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    if (!this.active || this.timings.length === 0) {
      // Pass audio through unchanged
      this.passThrough(inputs, outputs);
      return true;
    }

    const input = inputs[0]?.[0];
    if (!input) return true;

    // Pass audio through (the emitter is a pass-through node,
    // it only observes — it does not modify audio)
    this.passThrough(inputs, outputs);

    const frameSamples = input.length; // Typically 128
    const frameEndSample = this.sampleCounter + frameSamples;

    // Check if any boundaries fall within this frame
    while (
      this.currentIndex < this.timings.length &&
      this.timings[this.currentIndex].sampleOffset < frameEndSample
    ) {
      const entry = this.timings[this.currentIndex];

      // Fire a boundary event for each boundary type this word starts
      for (const boundaryType of entry.boundaries) {
        this.port.postMessage({
          type: boundaryType,
          astNodeId: entry.astNodeId,
          blockId: this.blockId,
          indexInBlock: this.currentIndex,
          audioTimestampMs: (entry.sampleOffset / sampleRate) * 1000,
        } as BoundaryEvent);
      }

      this.currentIndex++;
    }

    // Detect block end
    if (this.currentIndex >= this.timings.length) {
      this.port.postMessage({
        type: 'block_end',
        astNodeId: this.timings[this.timings.length - 1]?.astNodeId ?? '',
        blockId: this.blockId,
        indexInBlock: this.timings.length - 1,
        audioTimestampMs: (this.sampleCounter / sampleRate) * 1000,
      } as BoundaryEvent);
      this.active = false;
    }

    this.sampleCounter = frameEndSample;
    return true;
  }

  private passThrough(inputs: Float32Array[][], outputs: Float32Array[][]) {
    for (let ch = 0; ch < outputs[0].length; ch++) {
      outputs[0][ch].set(inputs[0]?.[ch] ?? new Float32Array(128));
    }
  }

  private findIndexAtSample(sample: number): number {
    // Binary search for the timing entry at or just after this sample
    let lo = 0, hi = this.timings.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.timings[mid].sampleOffset < sample) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}

registerProcessor('boundary-emitter', BoundaryEmitterProcessor);
```

**Key properties of this design:**
- The emitter is a **pass-through audio node** — it does not modify the audio stream. It only observes sample flow and posts messages.
- Boundary detection runs at **audio-clock resolution** (~2.67ms per frame at 48kHz/128). At 900 WPM with ~65ms per word, that's ~24 checks per word — more than enough precision.
- The emitter is **immune to main-thread jank**. Even if the main thread freezes for 200ms during a heavy DOM update, the emitter continues counting samples and will post all boundary events that occurred during the freeze. The main thread receives them in order when it unblocks.
- The timing array is loaded once per block. On block transitions, the `block_end` event triggers loading the next block's timings.

#### Component 2: Reading Position State Machine

The state machine runs on the main thread and consumes boundary events from the AudioWorklet. It is the **single source of truth** for "where are we right now" — every other system (highlighting, progress bar, annotation triggers, reading-position bookmarks, voice-change triggers) reads from it.

```typescript
interface ReadingPosition {
  // Current positions at every level of the hierarchy
  word: { astNodeId: string; indexInBlock: number };
  clause: { astNodeId: string };         // Enclosing clause node
  sentence: { astNodeId: string };       // Enclosing sentence node
  paragraph: { astNodeId: string };      // Enclosing paragraph node
  section: { astNodeId: string };        // Enclosing section/page node

  // Block-level tracking
  blockId: string;
  audioTimestampMs: number;

  // Document-level tracking
  plainTextOffset: number;               // Character offset in flat text
  progressPercent: number;               // 0-100
}

type PositionChangeCallback = (
  position: ReadingPosition,
  changedLevels: Set<string>  // Which levels changed: 'word', 'clause', etc.
) => void;

class ReadingPositionStateMachine {
  private position: ReadingPosition;
  private ast: DocumentAST;
  private listeners: PositionChangeCallback[] = [];

  // Predictive schedule (see Component 3)
  private scheduledTransitions: Map<number, NodeJS.Timeout> = new Map();

  constructor(ast: DocumentAST) {
    this.ast = ast;
  }

  // Called when a boundary event arrives from the AudioWorklet
  onBoundaryEvent(event: BoundaryEvent) {
    const previousPosition = { ...this.position };
    const changedLevels = new Set<string>();

    // Always update word position
    this.position.word = {
      astNodeId: event.astNodeId,
      indexInBlock: event.indexInBlock,
    };
    this.position.blockId = event.blockId;
    this.position.audioTimestampMs = event.audioTimestampMs;
    changedLevels.add('word');

    // Walk up the AST from the word node to update enclosing levels
    const wordNode = this.ast.getNode(event.astNodeId);
    const enclosingClause = this.ast.findAncestor(wordNode, 'clause');
    const enclosingSentence = this.ast.findAncestor(wordNode, 'sentence');
    const enclosingParagraph = this.ast.findAncestor(wordNode, 'paragraph');
    const enclosingSection = this.ast.findAncestor(wordNode, 'section');

    if (enclosingClause?.id !== previousPosition.clause?.astNodeId) {
      this.position.clause = { astNodeId: enclosingClause!.id };
      changedLevels.add('clause');
    }
    if (enclosingSentence?.id !== previousPosition.sentence?.astNodeId) {
      this.position.sentence = { astNodeId: enclosingSentence!.id };
      changedLevels.add('sentence');
    }
    if (enclosingParagraph?.id !== previousPosition.paragraph?.astNodeId) {
      this.position.paragraph = { astNodeId: enclosingParagraph!.id };
      changedLevels.add('paragraph');
    }
    if (enclosingSection?.id !== previousPosition.section?.astNodeId) {
      this.position.section = { astNodeId: enclosingSection!.id };
      changedLevels.add('section');
    }

    // Update document-level tracking
    this.position.plainTextOffset = wordNode.plainTextRange[0];
    this.position.progressPercent = this.computeProgress();

    // Handle block_end: trigger next block transition
    if (event.type === 'block_end') {
      changedLevels.add('block_end');
      this.onBlockEnd(event.blockId);
    }

    // Cancel any predictive transitions that this event supersedes
    this.cancelStaleScheduledTransitions(event.indexInBlock);

    // Notify all listeners
    for (const listener of this.listeners) {
      listener(this.position, changedLevels);
    }
  }

  // Subscribe to position changes.
  // Listeners can filter by which levels they care about.
  subscribe(callback: PositionChangeCallback) {
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter(l => l !== callback);
    };
  }

  // Snapshot for bookmark saving, progress persistence, etc.
  getPosition(): Readonly<ReadingPosition> {
    return Object.freeze({ ...this.position });
  }

  private onBlockEnd(finishedBlockId: string) {
    // Signal the BlockBufferManager to begin playback of the next block
    // and load that block's timing array into the AudioWorklet emitter.
    this.emit('requestNextBlock', finishedBlockId);
  }

  private computeProgress(): number {
    const totalChars = this.ast.totalCharacters;
    return (this.position.plainTextOffset / totalChars) * 100;
  }
}
```

**What makes this a state machine rather than just event forwarding:**
- It maintains the **full hierarchical position** (word, clause, sentence, paragraph, section) and only recomputes higher levels when they actually change. A word boundary event doesn't trigger a paragraph highlight update unless the paragraph actually changed.
- It tracks `changedLevels` so listeners can efficiently skip irrelevant updates. The word-level highlight refreshes 15 times/second at 900 WPM; the paragraph-level highlight refreshes maybe once every 5-10 seconds. Listeners that only care about paragraph changes ignore the 15/s word events.
- It coordinates **block transitions**. When the AudioWorklet signals `block_end`, the state machine tells the buffer manager to feed the next block's audio into the Web Audio graph and load the next timing array into the emitter. This is the seamless block-to-block stitching mechanism.

#### Component 3: Predictive Pre-Scheduling with Correction

The AudioWorklet boundary events are authoritative but arrive asynchronously via `MessagePort`. There's a small, variable delay (typically 1-5ms, occasionally 10-20ms under load) between the audio thread detecting a boundary and the main thread receiving the message. For highlight transitions, even 10ms of delay can cause a visible "lag behind audio" effect — the user hears the next word before seeing it highlighted.

To compensate, the system pre-schedules highlight transitions using the simulated timings, then uses the AudioWorklet events as correction checkpoints:

```typescript
class PredictiveHighlightScheduler {
  private stateMachine: ReadingPositionStateMachine;
  private highlightEngine: HighlightEngine;
  private currentBlockTimings: WordTiming[] = [];
  private scheduledTimers: Map<number, ReturnType<typeof setTimeout>> = new Map();
  private audioStartTime: number = 0;     // performance.now() when block playback began
  private driftCorrectionMs: number = 0;  // Accumulated correction from worklet events

  // Called when a new block begins playing
  onBlockStart(blockTimings: WordTiming[], audioStartTime: number) {
    this.cancelAllScheduled();
    this.currentBlockTimings = blockTimings;
    this.audioStartTime = audioStartTime;
    this.driftCorrectionMs = 0;

    // Pre-schedule all word transitions for this block
    for (let i = 0; i < blockTimings.length; i++) {
      const timing = blockTimings[i];
      const delayMs = timing.startMs - this.driftCorrectionMs;

      const timer = setTimeout(() => {
        // Optimistically update the highlight
        this.highlightEngine.preemptiveWordTransition(timing.astNodeId);
        this.scheduledTimers.delete(i);
      }, Math.max(0, delayMs));

      this.scheduledTimers.set(i, timer);
    }
  }

  // Called when an AudioWorklet boundary event arrives (ground truth)
  onBoundaryCorrection(event: BoundaryEvent) {
    const expectedAudioTimeMs = event.audioTimestampMs;
    const actualWallTimeMs = performance.now() - this.audioStartTime;

    // Compute drift: positive means wall clock is ahead of audio clock
    // (highlight fired too early), negative means behind (too late)
    const newDrift = actualWallTimeMs - expectedAudioTimeMs;
    this.driftCorrectionMs = newDrift;

    // If the highlight was pre-scheduled correctly, do nothing —
    // the optimistic transition already happened.
    // If drift exceeds threshold, re-schedule remaining transitions.
    if (Math.abs(newDrift - this.driftCorrectionMs) > 8) { // 8ms threshold
      this.rescheduleRemaining(event.indexInBlock, newDrift);
    }

    // Confirm the position in the state machine (authoritative)
    this.stateMachine.onBoundaryEvent(event);
  }

  private rescheduleRemaining(fromIndex: number, correctionMs: number) {
    for (let i = fromIndex + 1; i < this.currentBlockTimings.length; i++) {
      const existing = this.scheduledTimers.get(i);
      if (existing) clearTimeout(existing);

      const timing = this.currentBlockTimings[i];
      const correctedDelay = timing.startMs - correctionMs -
        (performance.now() - this.audioStartTime);

      const timer = setTimeout(() => {
        this.highlightEngine.preemptiveWordTransition(timing.astNodeId);
        this.scheduledTimers.delete(i);
      }, Math.max(0, correctedDelay));

      this.scheduledTimers.set(i, timer);
    }
  }

  private cancelAllScheduled() {
    for (const timer of this.scheduledTimers.values()) {
      clearTimeout(timer);
    }
    this.scheduledTimers.clear();
  }
}
```

**How the three components interact during normal playback:**

```
Audio Thread (AudioWorklet)          Main Thread
─────────────────────────────        ─────────────────────────────────────
                                     Block starts playing.
                                     PredictiveScheduler pre-schedules
                                     all word transitions via setTimeout.
                                     
                                     setTimeout fires for word 1 →
                                     Highlight snaps to word 1 (optimistic)
                                     
Sample counter crosses word 1 →      
Posts boundary event ──────────────→ StateMachine confirms word 1 (authoritative)
                                     Scheduler checks drift: 2ms → OK, no correction
                                     
                                     setTimeout fires for word 2 →
                                     Highlight snaps to word 2 (optimistic)
                                     
Sample counter crosses word 2 →
Posts boundary event ──────────────→ StateMachine confirms word 2
                                     Scheduler checks drift: 3ms → OK
                                     
                                     ... (main thread does heavy DOM work, 
                                     setTimeout for word 5 fires 12ms late) ...
                                     
Sample counter crosses word 5 →
Posts boundary event ──────────────→ StateMachine confirms word 5
                                     Scheduler detects 12ms drift → reschedules
                                     words 6-N with correction applied
```

**The result:** Highlights appear to move in perfect sync with audio. The pre-scheduling makes transitions visually smooth (they fire proactively rather than reactively). The AudioWorklet events ensure the system never drifts more than one correction cycle. The state machine is always authoritative and consistent.

#### What This Enables Beyond Highlighting

Because the state machine fires typed boundary events with `changedLevels`, any system can subscribe to precisely the granularity it needs:

```typescript
// Auto-pause at sentence boundaries (for study mode)
stateMachine.subscribe((position, changed) => {
  if (changed.has('sentence') && settings.autoPauseAtSentence) {
    audioPlayer.pause();
  }
});

// Log reading progress to Supabase every paragraph
stateMachine.subscribe((position, changed) => {
  if (changed.has('paragraph')) {
    supabase.from('reading_positions').upsert({ document_id: documentId, ...position });
  }
});

// Trigger voice change at block boundaries
stateMachine.subscribe((position, changed) => {
  if (changed.has('block_end')) {
    const nextBlock = blockBuffer.getNextBlock(position.blockId);
    if (nextBlock.voiceId !== currentVoiceId) {
      audioGraph.crossfadeToNewSource(nextBlock);
    }
  }
});

// Reading speed analytics (actual measured WPM, not target WPM)
stateMachine.subscribe((position, changed) => {
  if (changed.has('word')) {
    analytics.recordWordTimestamp(position.word.astNodeId, Date.now());
  }
});

// Sync partner/classroom reading — broadcast position to peers
stateMachine.subscribe((position, changed) => {
  if (changed.has('sentence')) {
    realtimeChannel.broadcast({ type: 'position', position });
  }
});
```

### 5. Expressive Synthesis System

The Expressive Synthesis System has three layers that work together. Each layer has a default configuration and is fully user-customizable. Users can save and share complete configurations as **Style Packages**.

```
Layer A: Voice Assignment          — Which voice speaks this text?
Layer B: Auditory Formatting       — How does the voice modulate to convey visual formatting?
Layer C: Emotional Expressiveness  — How does the voice modulate to convey meaning and feeling?

+ Whitespace-to-Pause mapping      — How does blank space become silence?
```

All three layers plus the pause mapping are combined during text segmentation to produce **synthesis instructions** for each speech block. These instructions travel with the block through the pipeline — HeadTTS uses them to shape its output, and libsonic respects them during time-stretching.

#### 5a. Layer A: Voice Assignment

This layer determines *which voice* speaks each segment. A voice change always creates a new block boundary.

```typescript
interface VoiceAssignment {
  id: string;
  condition: VoiceCondition;
  voiceId: string;              // HeadTTS voice or Replicate model
  priority: number;             // Higher priority wins when multiple conditions match
}

type VoiceCondition =
  | { type: 'font'; fontFamily: string }
  | { type: 'style'; fontStyle: 'italic' | 'bold' | 'bolditalic' }
  | { type: 'size'; comparison: 'gt' | 'lt' | 'eq'; value: number }
  | { type: 'color'; color: string }
  | { type: 'semantic'; role: 'heading' | 'blockquote' | 'code'
      | 'footnote' | 'caption' | 'aside' | 'emphasis' | 'link'
      | 'list_item' | 'table_cell' }
  | { type: 'highlight'; highlightColor: string }
  | { type: 'custom'; attributeKey: string; attributeValue: string }
  | { type: 'default' };           // Fallback voice for unmatched text

// Default: single voice for everything.
// Users who want multi-voice reading enable assignments.
```

#### 5b. Layer B: Auditory Formatting (Format → Sound)

This is the auditory analogue system. Instead of (or in addition to) switching voices, the system **modulates properties of the current voice** to create consistent, learnable auditory signals for visual formatting. The listener learns these signals the same way a sighted reader learns what bold or italics means — through repeated, consistent association.

The key design principle: visual formatting serves *functional* purposes (emphasis, hierarchy, attribution, distinction). The auditory system preserves those functions, not just decoratively varies the sound. A listener at 700 WPM needs to instantly *hear* that something is a heading, a quote, a footnote, a citation, without conscious effort.

```typescript
// An AuditoryStyle describes how to modulate the voice for a given format.
// All values are relative to the base voice: 1.0 = no change.
interface AuditoryStyle {
  // Prosodic modifications
  speedFactor: number;            // 0.5-2.0, relative to current speed
  pitchShift: number;             // Semitones: -6 to +6
  pitchRange: number;             // 0.5 = monotone, 1.0 = normal, 1.5 = expressive
  volumeFactor: number;           // 0.5-1.5, relative to base volume

  // Temporal modifications
  pauseBefore: number;            // Milliseconds of silence before this segment
  pauseAfter: number;             // Milliseconds of silence after this segment
  wordSpacing: number;            // Multiplier on inter-word gaps (1.0 = normal)

  // Timbral/quality hints (applied via Web Audio post-processing)
  reverbLevel: number;            // 0.0-1.0 (for blockquotes, "quoted" feel)
  compressionAmount: number;      // 0.0-1.0 (for bold: tighter dynamic range)
  brightnessShift: number;        // -1.0 to 1.0 (EQ tilt: negative=warm, positive=crisp)

  // Earcon / non-speech signal
  earconBefore?: string;          // Optional audio cue ID played before segment
  earconAfter?: string;           // Optional audio cue ID played after segment
}

// A FormatStyleRule maps a formatting condition to an AuditoryStyle.
interface FormatStyleRule {
  id: string;
  condition: VoiceCondition;      // Same condition types as Layer A
  style: Partial<AuditoryStyle>;  // Only specify what changes; rest inherits base
  priority: number;
  stackable: boolean;             // Can this combine with other active rules?
}
```

**Default Auditory Formatting Package — "Clear Reader":**

```typescript
const CLEAR_READER_PACKAGE: FormatStyleRule[] = [
  // ─── Emphasis ─────────────────────────────────────────────
  {
    id: 'bold',
    condition: { type: 'style', fontStyle: 'bold' },
    style: {
      speedFactor: 0.92,          // Slightly slower — weight and gravity
      volumeFactor: 1.12,         // Slightly louder — presence
      compressionAmount: 0.3,     // Tighter dynamic range — solidity
      pitchRange: 0.85,           // Narrower pitch variation — deliberate
      wordSpacing: 1.1,           // Slightly more space between words
    },
    priority: 10,
    stackable: true,
  },
  {
    id: 'italic',
    condition: { type: 'style', fontStyle: 'italic' },
    style: {
      pitchShift: 0.5,            // Half semitone up — lightness, distinction
      pitchRange: 1.2,            // More expressive range — fluidity
      speedFactor: 0.96,          // Very slightly slower
      brightnessShift: 0.2,       // Slightly brighter timbre
    },
    priority: 10,
    stackable: true,
  },
  {
    id: 'bold-italic',
    condition: { type: 'style', fontStyle: 'bolditalic' },
    style: {
      speedFactor: 0.88,          // Combines bold + italic slowdown
      volumeFactor: 1.15,
      pitchShift: 0.5,
      pitchRange: 1.1,
      compressionAmount: 0.25,
      pauseBefore: 80,
      pauseAfter: 80,
    },
    priority: 15,
    stackable: false,             // Replaces individual bold/italic rules
  },
  {
    id: 'underline',
    condition: { type: 'custom', attributeKey: 'textDecoration', attributeValue: 'underline' },
    style: {
      speedFactor: 0.94,
      pitchRange: 0.9,            // Slight flattening — marking, not emphasis
      earconBefore: 'soft-click', // Subtle audio cue: "something is marked here"
    },
    priority: 8,
    stackable: true,
  },

  // ─── Hierarchy ────────────────────────────────────────────
  {
    id: 'heading-1',
    condition: { type: 'semantic', role: 'heading' },
    style: {
      speedFactor: 0.80,          // Noticeably slower — authority, weight
      pitchShift: -1.5,           // Lower pitch — gravitas
      volumeFactor: 1.2,          // Louder
      pauseBefore: 800,           // Long pause before — section break
      pauseAfter: 500,            // Pause after — let it land
      pitchRange: 0.7,            // Flatter delivery — declarative
      compressionAmount: 0.4,
    },
    priority: 20,
    stackable: false,
  },
  {
    id: 'subheading',
    condition: { type: 'size', comparison: 'gt', value: 14 }, // Larger than body text
    style: {
      speedFactor: 0.88,
      pitchShift: -0.8,
      volumeFactor: 1.1,
      pauseBefore: 500,
      pauseAfter: 300,
    },
    priority: 18,
    stackable: false,
  },

  // ─── Attribution and Distinction ──────────────────────────
  {
    id: 'blockquote',
    condition: { type: 'semantic', role: 'blockquote' },
    style: {
      pitchShift: 0.3,
      reverbLevel: 0.15,          // Subtle reverb — "quoted" / "from elsewhere"
      volumeFactor: 0.95,         // Slightly quieter — recessive
      pauseBefore: 400,
      pauseAfter: 400,
      brightnessShift: -0.15,     // Slightly warmer — intimate, reflective
    },
    priority: 12,
    stackable: true,
  },
  {
    id: 'footnote',
    condition: { type: 'semantic', role: 'footnote' },
    style: {
      speedFactor: 0.90,          // Slower — careful, supplementary
      pitchShift: 1.5,            // Higher pitch — smaller, parenthetical
      volumeFactor: 0.85,         // Quieter — secondary importance
      pauseBefore: 300,
      earconBefore: 'footnote-chime', // Distinct chime: "this is a footnote"
      pauseAfter: 300,
      earconAfter: 'footnote-end',
    },
    priority: 15,
    stackable: false,
  },
  {
    id: 'caption',
    condition: { type: 'semantic', role: 'caption' },
    style: {
      speedFactor: 0.92,
      pitchShift: 0.8,
      volumeFactor: 0.9,
      pauseBefore: 200,
      pauseAfter: 200,
    },
    priority: 12,
    stackable: false,
  },
  {
    id: 'header-footer',
    condition: { type: 'semantic', role: 'aside' },
    style: {
      speedFactor: 0.85,
      pitchShift: 1.0,            // Higher — clearly subordinate
      volumeFactor: 0.80,         // Noticeably quieter
      pitchRange: 0.7,            // Flat — informational, not narrative
      earconBefore: 'aside-tick',
      pauseBefore: 250,
      pauseAfter: 250,
    },
    priority: 14,
    stackable: false,
  },
  {
    id: 'code',
    condition: { type: 'semantic', role: 'code' },
    style: {
      speedFactor: 0.70,          // Much slower — precision matters
      pitchRange: 0.5,            // Very flat — mechanical, precise
      wordSpacing: 1.4,           // Extra space between tokens
      brightnessShift: 0.3,       // Crisp/clinical timbre
      earconBefore: 'code-start',
      earconAfter: 'code-end',
      pauseBefore: 200,
      pauseAfter: 200,
    },
    priority: 15,
    stackable: false,
  },
  {
    id: 'link',
    condition: { type: 'semantic', role: 'link' },
    style: {
      pitchShift: 0.4,
      brightnessShift: 0.15,
      earconBefore: 'link-tone',  // Brief rising tone: "this is a link"
    },
    priority: 5,
    stackable: true,
  },

  // ─── Color Highlighting ───────────────────────────────────
  // When text has a background highlight color (author-applied or user-applied),
  // the auditory system signals it. Users who highlight in multiple colors
  // for different purposes get distinct auditory feedback.
  {
    id: 'highlight-yellow',
    condition: { type: 'highlight', highlightColor: '#FFFF00' },
    style: {
      volumeFactor: 1.05,
      brightnessShift: 0.1,
      earconBefore: 'highlight-yellow-tick',
    },
    priority: 3,
    stackable: true,
  },
  {
    id: 'highlight-blue',
    condition: { type: 'highlight', highlightColor: '#ADD8E6' },
    style: {
      pitchShift: -0.3,
      reverbLevel: 0.08,
      earconBefore: 'highlight-blue-tick',
    },
    priority: 3,
    stackable: true,
  },
  {
    id: 'highlight-green',
    condition: { type: 'highlight', highlightColor: '#90EE90' },
    style: {
      pitchShift: 0.3,
      brightnessShift: -0.1,
      earconBefore: 'highlight-green-tick',
    },
    priority: 3,
    stackable: true,
  },
  {
    id: 'highlight-pink',
    condition: { type: 'highlight', highlightColor: '#FFB6C1' },
    style: {
      pitchShift: 0.6,
      volumeFactor: 1.03,
      earconBefore: 'highlight-pink-tick',
    },
    priority: 3,
    stackable: true,
  },
];
```

**Rule stacking:** When `stackable: true`, multiple rules can apply simultaneously and their effects combine. Bold + italic + yellow highlight = slightly slower + slightly louder + compressed + higher pitch + brighter + earcon. Non-stackable rules (like heading or code) replace all lower-priority stackable rules.

**How AuditoryStyle applies in the pipeline:**

1. **During text segmentation:** Each word/span in the AST is evaluated against all active FormatStyleRules. The resulting `AuditoryStyle` is attached to the word's synthesis instructions.
2. **During HeadTTS synthesis:** `pitchShift` and `pitchRange` are encoded as prosody parameters in the synthesis request. Kokoro doesn't support all parameters natively — unsupported ones are deferred to post-processing.
3. **During libsonic stretching:** `speedFactor` adjustments are applied per-word by varying the stretch rate within a block. Libsonic supports changing speed mid-stream.
4. **During Web Audio playback:** `volumeFactor`, `reverbLevel`, `compressionAmount`, and `brightnessShift` are applied via a per-block Web Audio processing chain: GainNode (volume) → BiquadFilterNode (brightness EQ) → DynamicsCompressorNode (compression) → ConvolverNode (reverb). Parameters are automated per-word using `AudioParam.setValueAtTime()` against the simulated timing array.
5. **Pauses and earcons:** `pauseBefore`/`pauseAfter` are injected as silence samples during block assembly. Earcons are pre-loaded AudioBuffers mixed into the output at the appropriate sample offsets.

#### 5c. Layer C: Content-Driven Emotional Expressiveness

This layer analyzes the *meaning* of the text — not its formatting — and assigns emotional/prosodic coloring. A passage about grief sounds different from a passage about triumph, even when both are plain body text in the same font.

**Analysis happens during text segmentation, not at synthesis time.** When a speech block is created, Claude API analyzes it and returns emotional parameters:

```typescript
interface EmotionalAnnotation {
  blockId: string;
  overallMood: EmotionalMood;
  segments: EmotionalSegment[];    // Sub-block regions with distinct emotions
}

interface EmotionalSegment {
  startWordIndex: number;
  endWordIndex: number;
  mood: EmotionalMood;
  intensity: number;               // 0.0 (neutral) to 1.0 (maximum)
  transitionType: 'sudden' | 'gradual';  // How to blend from previous segment
}

interface EmotionalMood {
  primary: EmotionCategory;
  secondary?: EmotionCategory;     // For mixed emotions (e.g., bittersweet)
  valence: number;                 // -1.0 (negative) to 1.0 (positive)
  arousal: number;                 // 0.0 (calm/subdued) to 1.0 (energetic/intense)
  dominance: number;               // 0.0 (submissive/uncertain) to 1.0 (commanding/certain)
}

type EmotionCategory =
  | 'neutral'
  | 'joy' | 'excitement' | 'tenderness' | 'amusement' | 'triumph'
  | 'sadness' | 'grief' | 'melancholy' | 'nostalgia'
  | 'anger' | 'frustration' | 'indignation'
  | 'fear' | 'anxiety' | 'dread' | 'suspense'
  | 'surprise' | 'wonder' | 'revelation'
  | 'contemplation' | 'solemnity' | 'reverence'
  | 'irony' | 'sarcasm' | 'dry_humor'
  | 'urgency' | 'determination' | 'resolve'
  | 'intimacy' | 'vulnerability' | 'confession';
```

**Claude analysis prompt (run once per block during segmentation):**

```typescript
async function analyzeBlockEmotion(
  blockText: string,
  surroundingContext: { before: string; after: string }
): Promise<EmotionalAnnotation> {
  const result = await anthropicMCP.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    system: `You are an emotional prosody analyzer for a screen reader.
             Analyze text passages and return JSON describing the emotional
             content for text-to-speech expressiveness. Be conservative —
             default to neutral for informational text. Only assign strong
             emotions when the text clearly warrants it.`,
    messages: [{
      role: 'user',
      content: `Analyze this passage for emotional content and prosodic intent.
                Consider the surrounding context for emotional arc.

                Context before: "${surroundingContext.before}"

                PASSAGE TO ANALYZE:
                "${blockText}"

                Context after: "${surroundingContext.after}"

                For each distinct emotional segment, return:
                - Start and end word indices
                - Primary emotion (from: neutral, joy, excitement, tenderness,
                  amusement, triumph, sadness, grief, melancholy, nostalgia,
                  anger, frustration, indignation, fear, anxiety, dread,
                  suspense, surprise, wonder, revelation, contemplation,
                  solemnity, reverence, irony, sarcasm, dry_humor, urgency,
                  determination, resolve, intimacy, vulnerability, confession)
                - Secondary emotion if mixed
                - Valence (-1 to 1), Arousal (0 to 1), Dominance (0 to 1)
                - Intensity (0 to 1)
                - Transition from previous segment: sudden or gradual

                Return ONLY JSON, no preamble. If the passage is emotionally
                uniform, return a single segment covering the whole block.`
    }],
  });

  return parseEmotionalAnnotation(result);
}
```

**Emotional mood → AuditoryStyle mapping:**

Each emotion maps to prosodic modifications. These defaults draw on research in affective prosody. All modifications are scaled by the segment's intensity value (0-1), so a mildly sad passage gets subtle effects while deeply grief-stricken text is strongly modulated.

```typescript
const EMOTION_STYLE_MAP: Record<EmotionCategory, (intensity: number) => Partial<AuditoryStyle>> = {
  neutral: (_i) => ({}),  // No modification

  // ─── Positive / High Arousal ───
  joy: (i) => ({
    pitchShift: i * 1.5,               // Brighter
    pitchRange: 1.0 + i * 0.4,         // More melodic variation
    speedFactor: 1.0 + i * 0.08,       // Slightly faster
    brightnessShift: i * 0.2,
    volumeFactor: 1.0 + i * 0.05,
  }),
  excitement: (i) => ({
    pitchShift: i * 2.0,
    pitchRange: 1.0 + i * 0.5,
    speedFactor: 1.0 + i * 0.12,
    volumeFactor: 1.0 + i * 0.1,
    brightnessShift: i * 0.25,
  }),
  tenderness: (i) => ({
    pitchShift: i * 0.5,
    volumeFactor: 1.0 - i * 0.08,      // Softer
    speedFactor: 1.0 - i * 0.08,       // Slower
    brightnessShift: i * -0.15,         // Warmer
    pitchRange: 1.0 + i * 0.15,
  }),
  amusement: (i) => ({
    pitchShift: i * 1.0,
    pitchRange: 1.0 + i * 0.35,
    speedFactor: 1.0 + i * 0.05,
    brightnessShift: i * 0.1,
  }),
  triumph: (i) => ({
    pitchShift: i * 1.0,
    pitchRange: 1.0 + i * 0.3,
    speedFactor: 1.0 + i * 0.05,
    volumeFactor: 1.0 + i * 0.15,      // Strong presence
    compressionAmount: i * 0.2,
  }),

  // ─── Negative / Low Arousal ───
  sadness: (i) => ({
    pitchShift: i * -1.5,              // Lower
    pitchRange: 1.0 - i * 0.3,         // Less melodic — flatter
    speedFactor: 1.0 - i * 0.12,       // Slower
    volumeFactor: 1.0 - i * 0.08,      // Quieter
    brightnessShift: i * -0.2,          // Darker timbre
  }),
  grief: (i) => ({
    pitchShift: i * -2.0,
    pitchRange: 1.0 - i * 0.4,
    speedFactor: 1.0 - i * 0.18,       // Noticeably slower
    volumeFactor: 1.0 - i * 0.1,
    wordSpacing: 1.0 + i * 0.3,        // Words further apart — heaviness
    brightnessShift: i * -0.3,
  }),
  melancholy: (i) => ({
    pitchShift: i * -1.0,
    pitchRange: 1.0 - i * 0.2,
    speedFactor: 1.0 - i * 0.08,
    brightnessShift: i * -0.15,
    reverbLevel: i * 0.1,              // Hint of distance
  }),
  nostalgia: (i) => ({
    pitchShift: i * -0.5,
    speedFactor: 1.0 - i * 0.1,
    brightnessShift: i * -0.2,          // Warm
    reverbLevel: i * 0.12,              // Slight distance — memory-like
    pitchRange: 1.0 + i * 0.1,
  }),

  // ─── Tension / High Arousal ───
  anger: (i) => ({
    pitchShift: i * -0.5,
    pitchRange: 1.0 + i * 0.3,         // Wide range — volatile
    speedFactor: 1.0 + i * 0.1,        // Faster — pressured
    volumeFactor: 1.0 + i * 0.15,      // Louder
    compressionAmount: i * 0.4,         // Tighter, more intense
    brightnessShift: i * 0.15,
  }),
  frustration: (i) => ({
    pitchShift: i * 0.5,
    pitchRange: 1.0 + i * 0.2,
    speedFactor: 1.0 + i * 0.06,
    compressionAmount: i * 0.25,
  }),
  indignation: (i) => ({
    pitchShift: i * -0.8,
    volumeFactor: 1.0 + i * 0.12,
    speedFactor: 1.0 - i * 0.05,       // Slightly slower — measured outrage
    compressionAmount: i * 0.3,
    pitchRange: 1.0 + i * 0.15,
  }),
  fear: (i) => ({
    pitchShift: i * 2.0,               // Higher — tense
    pitchRange: 1.0 + i * 0.4,
    speedFactor: 1.0 + i * 0.15,       // Faster — breathless
    volumeFactor: 1.0 - i * 0.05,      // Slightly quieter — shrinking
    wordSpacing: 1.0 - i * 0.15,       // Words closer — rushed
  }),
  anxiety: (i) => ({
    pitchShift: i * 1.0,
    speedFactor: 1.0 + i * 0.08,
    pitchRange: 1.0 + i * 0.2,
    wordSpacing: 1.0 - i * 0.1,
  }),
  dread: (i) => ({
    pitchShift: i * -1.0,
    speedFactor: 1.0 - i * 0.12,       // Slow — reluctant
    volumeFactor: 1.0 - i * 0.08,
    wordSpacing: 1.0 + i * 0.25,       // Heavy gaps
    brightnessShift: i * -0.25,
  }),
  suspense: (i) => ({
    speedFactor: 1.0 - i * 0.15,       // Slower — stretching time
    pitchRange: 1.0 - i * 0.2,         // Flatter — taut
    volumeFactor: 1.0 - i * 0.1,       // Quieter — held breath
    wordSpacing: 1.0 + i * 0.2,        // Deliberate spacing
  }),

  // ─── Discovery ───
  surprise: (i) => ({
    pitchShift: i * 2.5,               // Sharp rise
    pitchRange: 1.0 + i * 0.5,
    speedFactor: 1.0 + i * 0.1,
    volumeFactor: 1.0 + i * 0.1,
  }),
  wonder: (i) => ({
    pitchShift: i * 1.5,
    pitchRange: 1.0 + i * 0.3,
    speedFactor: 1.0 - i * 0.08,       // Slower — savoring
    brightnessShift: i * 0.15,
    reverbLevel: i * 0.08,             // Slight spaciousness
  }),
  revelation: (i) => ({
    pitchShift: i * 1.0,
    speedFactor: 1.0 - i * 0.1,
    volumeFactor: 1.0 + i * 0.08,
    pauseBefore: i * 200,              // Beat before the revelation
  }),

  // ─── Reflective / Low Arousal ───
  contemplation: (i) => ({
    speedFactor: 1.0 - i * 0.1,
    pitchRange: 1.0 - i * 0.15,
    wordSpacing: 1.0 + i * 0.15,       // Thoughtful pacing
    reverbLevel: i * 0.08,
  }),
  solemnity: (i) => ({
    pitchShift: i * -1.0,
    speedFactor: 1.0 - i * 0.15,
    pitchRange: 1.0 - i * 0.3,         // Flat — grave
    volumeFactor: 1.0 - i * 0.05,
    wordSpacing: 1.0 + i * 0.2,
  }),
  reverence: (i) => ({
    pitchShift: i * -0.5,
    speedFactor: 1.0 - i * 0.12,
    volumeFactor: 1.0 - i * 0.1,       // Hushed
    wordSpacing: 1.0 + i * 0.2,
    brightnessShift: i * -0.15,
  }),

  // ─── Wit / Social ───
  irony: (i) => ({
    pitchRange: 1.0 + i * 0.2,         // Slightly wider — knowing inflection
    speedFactor: 1.0 - i * 0.05,       // Fractionally slower — deliberate
  }),
  sarcasm: (i) => ({
    pitchRange: 1.0 + i * 0.3,         // Exaggerated contour
    speedFactor: 1.0 - i * 0.08,
    brightnessShift: i * 0.1,
  }),
  dry_humor: (i) => ({
    pitchRange: 1.0 - i * 0.15,        // Flatter — deadpan
    speedFactor: 1.0 - i * 0.03,
  }),

  // ─── Drive ───
  urgency: (i) => ({
    speedFactor: 1.0 + i * 0.15,       // Faster — pressing
    pitchShift: i * 1.0,
    volumeFactor: 1.0 + i * 0.1,
    wordSpacing: 1.0 - i * 0.2,        // Compressed gaps
    compressionAmount: i * 0.2,
  }),
  determination: (i) => ({
    pitchRange: 1.0 - i * 0.2,         // Narrower — unwavering
    volumeFactor: 1.0 + i * 0.08,
    compressionAmount: i * 0.3,
    speedFactor: 1.0 - i * 0.05,       // Measured, steady
  }),
  resolve: (i) => ({
    pitchShift: i * -0.5,
    pitchRange: 1.0 - i * 0.25,
    volumeFactor: 1.0 + i * 0.1,
    speedFactor: 1.0 - i * 0.08,
    compressionAmount: i * 0.2,
  }),

  // ─── Vulnerability ───
  intimacy: (i) => ({
    volumeFactor: 1.0 - i * 0.12,      // Softer — close, private
    pitchShift: i * -0.5,
    brightnessShift: i * -0.2,          // Warmer
    speedFactor: 1.0 - i * 0.08,
    reverbLevel: i * 0.05,
  }),
  vulnerability: (i) => ({
    pitchShift: i * 1.0,               // Slightly higher — exposed
    volumeFactor: 1.0 - i * 0.1,
    speedFactor: 1.0 - i * 0.1,
    pitchRange: 1.0 + i * 0.2,         // Unsteady
    wordSpacing: 1.0 + i * 0.1,
  }),
  confession: (i) => ({
    volumeFactor: 1.0 - i * 0.1,
    speedFactor: 1.0 - i * 0.1,
    pitchShift: i * -0.3,
    brightnessShift: i * -0.15,
    wordSpacing: 1.0 + i * 0.15,       // Halting, considered
  }),
};
```

**Gradual transitions between emotional segments:**

When `transitionType` is `'gradual'`, the system interpolates between the previous segment's style and the new segment's style over the first 3-5 words of the new segment. This prevents jarring jumps from "happy" to "sad" mid-paragraph. When `transitionType` is `'sudden'` (e.g., a shocking plot twist), the switch is immediate.

```typescript
function interpolateEmotionalStyle(
  prevStyle: Partial<AuditoryStyle>,
  nextStyle: Partial<AuditoryStyle>,
  progress: number  // 0.0 at start of transition, 1.0 at end
): Partial<AuditoryStyle> {
  const result: Partial<AuditoryStyle> = {};
  for (const key of Object.keys(nextStyle)) {
    const prev = (prevStyle as any)[key] ?? getBaseValue(key);
    const next = (nextStyle as any)[key];
    if (typeof prev === 'number' && typeof next === 'number') {
      (result as any)[key] = prev + (next - prev) * easeInOut(progress);
    }
  }
  return result;
}
```

**User control over emotional expressiveness:**

```typescript
interface EmotionalConfig {
  enabled: boolean;                    // Master toggle
  globalIntensityMultiplier: number;   // 0.0-2.0 (scale all emotion effects)
  perEmotionOverrides: Map<EmotionCategory, {
    enabled: boolean;
    intensityMultiplier: number;
    customStyle?: (intensity: number) => Partial<AuditoryStyle>;
  }>;
  analysisMode: 'full' | 'simple' | 'off';
    // full:   Claude API analysis per block (richest, uses API credits)
    // simple: Lightweight sentiment analysis only (positive/negative/neutral + intensity)
    //         Can run client-side with a small model
    // off:    No emotional modulation
}
```

Users who find emotional modulation distracting can disable it entirely, dial it to near-zero with `globalIntensityMultiplier: 0.1`, or disable specific emotions they find annoying (e.g., disable `sarcasm` if the detector is too aggressive).

#### 5d. Whitespace-to-Pause Mapping

Visual documents use blank space to convey structure — paragraph breaks, section gaps, page breaks, margins around headings, spacing between list items. Voxium Reader converts these spatial signals into precisely calibrated silence.

```typescript
interface PauseMapping {
  trigger: PauseTrigger;
  durationMs: number;              // Base duration at 1x speed
  scalesWithSpeed: boolean;        // If true, pause compresses at high speeds
  minimumMs: number;               // Floor duration even at max speed
}

type PauseTrigger =
  | 'word_boundary'                // Space between words
  | 'clause_boundary'              // Comma, semicolon, colon, em-dash
  | 'sentence_boundary'            // Period, question mark, exclamation
  | 'paragraph_break'              // Single blank line / paragraph end
  | 'section_break'                // Double blank line or <hr> or heading change
  | 'page_break'                   // Explicit page break in document
  | 'chapter_break'                // Chapter boundary
  | 'blank_lines_1'               // 1 blank line between paragraphs
  | 'blank_lines_2'               // 2 blank lines
  | 'blank_lines_3_plus'          // 3+ blank lines (scene break, section divider)
  | 'list_item_boundary'          // Between list items
  | 'table_row_boundary'          // Between table rows
  | 'table_cell_boundary'         // Between cells in a row
  | 'image_before'                // Before an image (or its description)
  | 'image_after'                 // After an image description
  | 'footnote_jump'               // When jumping to/from a footnote
  | 'blockquote_enter'            // Entering a blockquote
  | 'blockquote_exit'             // Leaving a blockquote
  | 'code_block_enter'
  | 'code_block_exit';

const DEFAULT_PAUSE_MAP: PauseMapping[] = [
  // ─── Intra-sentence ───
  { trigger: 'word_boundary',       durationMs: 0,    scalesWithSpeed: true,  minimumMs: 0 },
    // Word gaps are inherent in TTS output; no extra silence added
  { trigger: 'clause_boundary',     durationMs: 150,  scalesWithSpeed: true,  minimumMs: 30 },
  { trigger: 'sentence_boundary',   durationMs: 300,  scalesWithSpeed: true,  minimumMs: 60 },

  // ─── Structural ───
  { trigger: 'paragraph_break',     durationMs: 500,  scalesWithSpeed: true,  minimumMs: 100 },
  { trigger: 'blank_lines_1',       durationMs: 500,  scalesWithSpeed: true,  minimumMs: 100 },
  { trigger: 'blank_lines_2',       durationMs: 900,  scalesWithSpeed: true,  minimumMs: 180 },
  { trigger: 'blank_lines_3_plus',  durationMs: 1400, scalesWithSpeed: true,  minimumMs: 250 },
    // 3+ blank lines typically signals a scene break or major section divider.
    // The long pause gives the listener time to register the transition.
  { trigger: 'section_break',       durationMs: 1200, scalesWithSpeed: true,  minimumMs: 200 },
  { trigger: 'page_break',          durationMs: 800,  scalesWithSpeed: true,  minimumMs: 150 },
  { trigger: 'chapter_break',       durationMs: 2000, scalesWithSpeed: false, minimumMs: 2000 },
    // Chapter breaks always get a full 2-second pause regardless of speed.
    // This is a major cognitive boundary.

  // ─── Lists and Tables ───
  { trigger: 'list_item_boundary',  durationMs: 200,  scalesWithSpeed: true,  minimumMs: 40 },
  { trigger: 'table_row_boundary',  durationMs: 350,  scalesWithSpeed: true,  minimumMs: 70 },
  { trigger: 'table_cell_boundary', durationMs: 150,  scalesWithSpeed: true,  minimumMs: 30 },

  // ─── Media and Context Shifts ───
  { trigger: 'image_before',        durationMs: 300,  scalesWithSpeed: true,  minimumMs: 80 },
  { trigger: 'image_after',         durationMs: 300,  scalesWithSpeed: true,  minimumMs: 80 },
  { trigger: 'footnote_jump',       durationMs: 400,  scalesWithSpeed: true,  minimumMs: 100 },
  { trigger: 'blockquote_enter',    durationMs: 350,  scalesWithSpeed: true,  minimumMs: 80 },
  { trigger: 'blockquote_exit',     durationMs: 350,  scalesWithSpeed: true,  minimumMs: 80 },
  { trigger: 'code_block_enter',    durationMs: 300,  scalesWithSpeed: true,  minimumMs: 80 },
  { trigger: 'code_block_exit',     durationMs: 300,  scalesWithSpeed: true,  minimumMs: 80 },
];
```

**Speed scaling:** At 1x, a paragraph break is 500ms. At 4x, it scales to 125ms — but never below the 100ms floor. At 6x, it would be 83ms, but floors at 100ms. This ensures that even at maximum speed, structural pauses remain perceptible. Chapter breaks are exempt from scaling entirely — they always get their full duration.

**How blank space is detected:**

During document import, the AST builder counts consecutive blank lines, explicit spacing, and margin annotations from the source format (PDF line gaps, EPUB CSS margins, DOCX paragraph spacing). The pause mapper consults this information during text segmentation and injects silence tokens into the synthesis instructions:

```typescript
interface SilenceToken {
  type: 'silence';
  durationMs: number;           // After speed scaling + floor clamping
  trigger: PauseTrigger;         // For debugging / user visibility
  astNodeId: string;             // Where in the AST this silence occurs
}

// Speed-scaled duration calculation:
function computePauseDuration(
  mapping: PauseMapping,
  currentSpeed: number
): number {
  if (!mapping.scalesWithSpeed) return mapping.durationMs;
  const scaled = mapping.durationMs / currentSpeed;
  return Math.max(scaled, mapping.minimumMs);
}
```

Silence tokens are injected into the speech block's audio during the block assembly phase — they're concatenated as zero-amplitude samples at the correct positions. The simulated timing array includes them, so the AudioWorklet boundary emitter and highlighting engine account for pauses when computing word positions.

#### 5e. Style Packages

All of the above — voice assignments (Layer A), auditory formatting rules (Layer B), emotional expressiveness config (Layer C), and pause mappings — are bundled into **Style Packages** that can be saved, loaded, shared, and switched.

```typescript
interface StylePackage {
  id: string;
  name: string;
  description: string;
  author: string;                           // User or 'voxium-default'
  version: number;

  voiceAssignments: VoiceAssignment[];       // Layer A
  formatStyleRules: FormatStyleRule[];       // Layer B
  emotionalConfig: EmotionalConfig;          // Layer C
  pauseMappings: PauseMapping[];             // Whitespace → Silence

  earcons: Map<string, string>;              // Earcon ID → GCS URL or bundled asset
}

// Built-in packages:
const BUILTIN_PACKAGES: StylePackage[] = [
  {
    id: 'clear-reader',
    name: 'Clear Reader',
    description: 'Balanced auditory formatting with moderate emotional expressiveness. '
      + 'Good for general reading — novels, articles, reports.',
    author: 'voxium-default',
    voiceAssignments: [{ condition: { type: 'default' }, voiceId: 'kokoro-af_bella', priority: 0 }],
    formatStyleRules: CLEAR_READER_PACKAGE,
    emotionalConfig: {
      enabled: true,
      globalIntensityMultiplier: 0.6,
      analysisMode: 'full',
      perEmotionOverrides: new Map(),
    },
    pauseMappings: DEFAULT_PAUSE_MAP,
    earcons: DEFAULT_EARCONS,
  },
  {
    id: 'academic',
    name: 'Academic',
    description: 'Minimal emotional modulation. Strong structural pauses. '
      + 'Clear distinction between body text, citations, footnotes, and headings. '
      + 'Designed for textbooks, papers, and technical documents.',
    author: 'voxium-default',
    voiceAssignments: [
      { condition: { type: 'default' }, voiceId: 'kokoro-af_bella', priority: 0 },
      { condition: { type: 'semantic', role: 'footnote' }, voiceId: 'kokoro-af_sarah', priority: 10 },
    ],
    formatStyleRules: ACADEMIC_PACKAGE,     // Longer heading pauses, citation earcons,
                                             // strong header/footer distinction
    emotionalConfig: {
      enabled: true,
      globalIntensityMultiplier: 0.2,        // Very subtle
      analysisMode: 'simple',                // Lightweight, no API calls
      perEmotionOverrides: new Map(),
    },
    pauseMappings: ACADEMIC_PAUSE_MAP,       // Longer section breaks, shorter paragraph breaks
    earcons: ACADEMIC_EARCONS,
  },
  {
    id: 'dramatic',
    name: 'Dramatic',
    description: 'Maximum emotional expressiveness. Rich auditory formatting. '
      + 'Designed for fiction, poetry, and narrative non-fiction.',
    author: 'voxium-default',
    voiceAssignments: [
      { condition: { type: 'default' }, voiceId: 'kokoro-af_bella', priority: 0 },
      { condition: { type: 'semantic', role: 'blockquote' }, voiceId: 'kokoro-am_adam', priority: 10 },
    ],
    formatStyleRules: DRAMATIC_PACKAGE,      // Enhanced emphasis, dramatic blockquote reverb
    emotionalConfig: {
      enabled: true,
      globalIntensityMultiplier: 1.2,        // Strong — lean into the emotion
      analysisMode: 'full',
      perEmotionOverrides: new Map(),
    },
    pauseMappings: DRAMATIC_PAUSE_MAP,       // Extra-long scene breaks, dramatic sentence pauses
    earcons: DRAMATIC_EARCONS,
  },
  {
    id: 'speed-reader',
    name: 'Speed Reader',
    description: 'Minimal pauses, no earcons, reduced auditory formatting. '
      + 'Optimized for maximum information throughput at 500-900 WPM. '
      + 'Emotional modulation only for major mood shifts.',
    author: 'voxium-default',
    voiceAssignments: [{ condition: { type: 'default' }, voiceId: 'kokoro-af_bella', priority: 0 }],
    formatStyleRules: SPEED_READER_PACKAGE,  // Only heading + code formatting retained
    emotionalConfig: {
      enabled: true,
      globalIntensityMultiplier: 0.3,        // Barely there
      analysisMode: 'simple',
      perEmotionOverrides: new Map(),
    },
    pauseMappings: SPEED_READER_PAUSE_MAP,   // Compressed pauses, low minimums
    earcons: new Map(),                       // No earcons — pure speed
  },
  {
    id: 'plain',
    name: 'Plain',
    description: 'No auditory formatting, no emotional modulation, standard pauses. '
      + 'Closest to a traditional screen reader. Clean, uniform delivery.',
    author: 'voxium-default',
    voiceAssignments: [{ condition: { type: 'default' }, voiceId: 'kokoro-af_bella', priority: 0 }],
    formatStyleRules: [],                    // No formatting rules at all
    emotionalConfig: {
      enabled: false,
      globalIntensityMultiplier: 0,
      analysisMode: 'off',
      perEmotionOverrides: new Map(),
    },
    pauseMappings: MINIMAL_PAUSE_MAP,        // Standard sentence/paragraph pauses only
    earcons: new Map(),
  },
];
```

**User customization flow:**

1. Start from any built-in package (or from scratch).
2. Adjust any individual parameter: change the bold auditory style, increase heading pause duration, disable the link earcon, raise the emotional intensity for sadness, lower it for sarcasm.
3. Save as a custom package with a name.
4. Assign packages per-document (e.g., "Dramatic" for novels, "Academic" for papers) or set a global default.
5. Export packages as JSON for sharing. Import packages from other users.
6. Style packages are stored in Supabase and synced across devices via Realtime.

**Quick customization UI:** The style editor doesn't require users to understand all parameters. It offers:
- A **master intensity slider** for auditory formatting (how much formatting affects sound)
- A **master intensity slider** for emotional expressiveness
- A **pause scale slider** (shorter ↔ longer pauses)
- Individual toggles for each format rule (bold, italic, heading, footnote, etc.)
- An "Advanced" panel for users who want to edit individual AuditoryStyle values
- A **preview button** that reads a sample passage with the current settings

#### 5f. How the Three Layers Combine

When computing the final synthesis instructions for a word, the three layers apply in order. Layer B (formatting) and Layer C (emotion) are additive — they stack on top of each other.

```typescript
function computeSynthesisInstructions(
  wordNode: DocumentNode,
  wordIndex: number,
  block: SpeechBlock,
  stylePackage: StylePackage
): SynthesisInstructions {

  // Start with base voice parameters (all neutral: 1.0 / 0.0)
  let style: AuditoryStyle = { ...BASE_NEUTRAL_STYLE };

  // Layer A: Determine the voice
  const voiceId = resolveVoice(wordNode, stylePackage.voiceAssignments);

  // Layer B: Apply auditory formatting rules
  const matchingRules = stylePackage.formatStyleRules
    .filter(rule => matchesCondition(wordNode, rule.condition))
    .sort((a, b) => b.priority - a.priority);

  // Find the highest-priority non-stackable rule (if any)
  const topNonStackable = matchingRules.find(r => !r.stackable);

  if (topNonStackable) {
    style = mergeStyles(style, topNonStackable.style);
  }

  // Apply all stackable rules that aren't overridden
  for (const rule of matchingRules.filter(r => r.stackable)) {
    if (topNonStackable && rule.priority < topNonStackable.priority) continue;
    style = mergeStyles(style, rule.style);
  }

  // Layer C: Apply emotional expressiveness (additive on top of formatting)
  if (stylePackage.emotionalConfig.enabled && block.emotionalAnnotation) {
    const segment = block.emotionalAnnotation.segments.find(
      seg => wordIndex >= seg.startWordIndex && wordIndex <= seg.endWordIndex
    );
    if (segment) {
      const effectiveIntensity = segment.intensity
        * stylePackage.emotionalConfig.globalIntensityMultiplier;

      // Check per-emotion overrides
      const override = stylePackage.emotionalConfig.perEmotionOverrides
        .get(segment.mood.primary);
      const finalIntensity = override
        ? effectiveIntensity * (override.intensityMultiplier ?? 1.0)
        : effectiveIntensity;

      if (!override || override.enabled !== false) {
        const emotionStyleFn = override?.customStyle
          ?? EMOTION_STYLE_MAP[segment.mood.primary];
        const emotionStyle = emotionStyleFn(finalIntensity);

        // Handle gradual transitions between emotional segments
        if (segment.transitionType === 'gradual') {
          const transitionWords = 4;
          const wordsIntoSegment = wordIndex - segment.startWordIndex;
          if (wordsIntoSegment < transitionWords) {
            const prevSegment = findPreviousSegment(block.emotionalAnnotation, segment);
            if (prevSegment) {
              const prevStyle = EMOTION_STYLE_MAP[prevSegment.mood.primary](
                prevSegment.intensity * stylePackage.emotionalConfig.globalIntensityMultiplier
              );
              const progress = wordsIntoSegment / transitionWords;
              const blended = interpolateStyles(prevStyle, emotionStyle, progress);
              style = mergeStyles(style, blended);
            } else {
              style = mergeStyles(style, emotionStyle);
            }
          } else {
            style = mergeStyles(style, emotionStyle);
          }
        } else {
          style = mergeStyles(style, emotionStyle);
        }
      }
    }
  }

  // Compute pauses for this word's position in the document
  const pauses = computePauses(wordNode, stylePackage.pauseMappings, block.currentSpeed);

  return { voiceId, style, pauses };
}

// Style merging rules:
//   Multiplicative properties (speed, volume, pitchRange, wordSpacing):
//     merged = base * modifier   (so two 0.9x speed rules give 0.81x)
//   Additive properties (pitchShift, brightnessShift):
//     merged = base + modifier
//   Maximum properties (reverb, compression, pauseBefore, pauseAfter):
//     merged = max(base, modifier)
//   Earcons: collected into an ordered list, all play in sequence

function mergeStyles(base: AuditoryStyle, modifier: Partial<AuditoryStyle>): AuditoryStyle {
  return {
    speedFactor:        base.speedFactor * (modifier.speedFactor ?? 1.0),
    pitchShift:         base.pitchShift + (modifier.pitchShift ?? 0),
    pitchRange:         base.pitchRange * (modifier.pitchRange ?? 1.0),
    volumeFactor:       base.volumeFactor * (modifier.volumeFactor ?? 1.0),
    pauseBefore:        Math.max(base.pauseBefore, modifier.pauseBefore ?? 0),
    pauseAfter:         Math.max(base.pauseAfter, modifier.pauseAfter ?? 0),
    wordSpacing:        base.wordSpacing * (modifier.wordSpacing ?? 1.0),
    reverbLevel:        Math.max(base.reverbLevel, modifier.reverbLevel ?? 0),
    compressionAmount:  Math.max(base.compressionAmount, modifier.compressionAmount ?? 0),
    brightnessShift:    base.brightnessShift + (modifier.brightnessShift ?? 0),
    earconBefore:       modifier.earconBefore ?? base.earconBefore,
    earconAfter:        modifier.earconAfter ?? base.earconAfter,
  };
}
```

Voice assignments (Layer A) are stored in Supabase per user. The text segmenter consults these rules when creating speech blocks — a change of voice always forces a new block boundary. Auditory formatting and emotional parameters ride *within* blocks as per-word instructions, so they don't force block boundaries.

### 6. Dual-View System

#### 6a. Plain Text View

A clean, reflowable text display. No formatting distractions. Text is rendered from the AST's `text` content only. The highlighting engine uses character offset ranges for positioning.

Features:
- Adjustable font, size, line spacing, margins.
- High-contrast and dyslexia-friendly font options.
- Click/tap anywhere to move the speech cursor to that word.
- Select text to annotate or highlight.

#### 6b. Original Format View (Rendered Container)

This is **not** an embedded PDF viewer or an iframe showing the original file. It is a purpose-built rendering environment:

```typescript
// The OriginalFormatRenderer takes the AST and produces a visual replica
class OriginalFormatRenderer {
  private canvas: HTMLCanvasElement;    // For pixel-level overlay
  private domContainer: HTMLElement;     // For interactive elements

  async render(document: DocumentAST, viewport: Viewport) {
    // Strategy depends on source format:

    // PDF: Render pages via pdf.js onto canvas, then overlay
    //      interactive highlight/annotation layer via SVG
    if (document.sourceFormat === 'pdf') {
      await this.renderPDFPages(document);
    }

    // EPUB/HTML: Render XHTML content in sandboxed container
    //           with original CSS, overlay highlight layer
    if (document.sourceFormat === 'epub' || document.sourceFormat === 'html') {
      await this.renderHTMLContent(document);
    }

    // DOCX/RTF: Render via mammoth-to-HTML conversion with
    //           style-faithful CSS mapping
    if (document.sourceFormat === 'docx' || document.sourceFormat === 'rtf') {
      await this.renderDocumentHTML(document);
    }

    // All formats: Overlay the bounding-box-based highlight layer
    this.overlayHighlightLayer();
  }
}
```

**Computer Vision for Cursor Positioning:**

When the user clicks in the original-format view, we need to determine exactly which word they clicked. For rendered PDFs and images, this requires visual analysis:

```typescript
async function resolveClickToWord(
  clickX: number, clickY: number,
  pageNumber: number,
  renderer: OriginalFormatRenderer
): Promise<string | null> {  // Returns AST node ID

  // Strategy 1: Use pre-computed bounding boxes from import
  const hitNode = findNodeByBoundingBox(clickX, clickY, pageNumber);
  if (hitNode) return hitNode.id;

  // Strategy 2: For ambiguous regions, use vision model
  const screenshot = renderer.captureRegion(
    clickX - 100, clickY - 50,
    200, 100,  // Capture area around click
    pageNumber
  );

  // Send to Claude vision or Replicate vision model
  const result = await anthropicMCP.analyze({
    image: screenshot,
    prompt: `The user clicked at the red crosshair in this image of a document.
             Identify the exact word closest to the click position.
             Return the word and its approximate character position
             in the visible text.`
  });

  return this.matchVisionResultToAST(result, pageNumber);
}
```

**When to use computer vision vs. bounding boxes:**
- **Bounding boxes (fast, preferred):** When the document was imported with layout analysis and all word positions are known.
- **Computer vision (fallback):** For scanned PDFs, complex layouts where bounding boxes are unreliable, or when the user clicks in a region with overlapping elements.

### 7. Annotation, Highlighting, and Audio Notes

Voxium Reader treats annotation as a first-class system, not an afterthought. Annotations and highlights made in either view are reflected in the other and optionally written back to the source document. The system also supports **audio annotations** — the user can record voice notes at specific points in the document and play them back inline during reading.

#### 7a. Annotation Types

```typescript
type AnnotationType =
  | 'highlight'          // Color highlight over a text range
  | 'underline'          // Underline marking
  | 'strikethrough'      // Strikethrough marking
  | 'comment'            // Text comment attached to a range
  | 'sticky_note'        // Free-form note attached to a point
  | 'bookmark'           // Named position marker
  | 'audio_note'         // Recorded voice memo attached to a range or point
  | 'link'               // User-created cross-reference to another annotation or document
  | 'tag';               // Semantic tag on a range (e.g., "key finding", "methodology", "disagree")

interface Annotation {
  id: string;
  documentId: string;
  userId: string;
  type: AnnotationType;

  // Position: either a range (highlight, comment) or a point (bookmark, sticky note)
  anchorMode: 'range' | 'point';
  startAstNodeId: string;
  endAstNodeId?: string;                 // Only for range-based annotations
  startPlainTextOffset: number;
  endPlainTextOffset?: number;

  // Content
  color?: string;                        // For highlights, underlines, sticky notes
  text?: string;                         // For comments, sticky notes, tags
  audioUrl?: string;                     // For audio notes (Supabase Storage URL)
  audioDurationMs?: number;              // Length of the audio recording
  linkedAnnotationId?: string;           // For 'link' type — cross-reference
  linkedDocumentId?: string;             // For 'link' type — cross-document reference
  tags: string[];                        // User-applied semantic tags

  // Metadata
  createdAt: Date;
  updatedAt: Date;
  sourceView: 'plain' | 'original';     // Where the annotation was created
  pageNumber?: number;
  chapterName?: string;

  // Extracted text snapshot (for export and search)
  selectedText: string;                  // The exact text that was highlighted/annotated
}
```

#### 7b. Highlight Colors and Semantic Meaning

Users can assign semantic meaning to highlight colors, creating a personal annotation vocabulary:

```typescript
interface HighlightColorConfig {
  color: string;                         // Hex color
  label: string;                         // User-defined meaning
  defaultTag?: string;                   // Auto-applied tag when this color is used
  auditorySignal?: string;               // Earcon ID for this color (see §5b)
  keyboardShortcut?: string;             // Quick-apply shortcut
}

const DEFAULT_HIGHLIGHT_COLORS: HighlightColorConfig[] = [
  { color: '#FFFF00', label: 'Important',       keyboardShortcut: 'Alt+1' },
  { color: '#90EE90', label: 'Agree',           keyboardShortcut: 'Alt+2' },
  { color: '#FFB6C1', label: 'Disagree',        keyboardShortcut: 'Alt+3' },
  { color: '#ADD8E6', label: 'Follow up',       keyboardShortcut: 'Alt+4' },
  { color: '#DDA0DD', label: 'Key finding',     keyboardShortcut: 'Alt+5' },
  { color: '#FFA500', label: 'Methodology',     keyboardShortcut: 'Alt+6' },
];
```

Users customize these freely — rename labels, change colors, add more, assign different shortcuts. Colors sync across devices via Supabase.

#### 7c. Annotation Creation Flows

```typescript
class AnnotationManager {
  // ─── Text Selection → Annotation ───
  // User selects text in either view. A contextual toolbar appears:
  //
  //  ┌──────────────────────────────────────────────────────┐
  //  │ 🟡 🟢 🩷 🔵 🟣 🟠 │ 💬 Comment │ 🎙 Record │ 🏷 Tag │
  //  └──────────────────────────────────────────────────────┘
  //
  // Tapping a color creates a highlight. Other buttons create
  // comments, audio notes, or tags.

  onTextSelection(selection: TextSelection, view: 'plain' | 'original') {
    const startNode = this.resolveToASTNode(selection.start, view);
    const endNode = this.resolveToASTNode(selection.end, view);
    const selectedText = this.ast.extractTextBetween(startNode.id, endNode.id);

    this.showAnnotationToolbar({
      startAstNodeId: startNode.id,
      endAstNodeId: endNode.id,
      startPlainTextOffset: startNode.plainTextRange.start,
      endPlainTextOffset: endNode.plainTextRange.end,
      selectedText,
      sourceView: view,
    });
  }

  // ─── Create highlight ───
  createHighlight(anchor: AnnotationAnchor, color: string): Annotation {
    const colorConfig = this.getColorConfig(color);
    const annotation: Annotation = {
      id: generateId(),
      documentId: this.document.id,
      userId: this.userId,
      type: 'highlight',
      anchorMode: 'range',
      ...anchor,
      color,
      tags: colorConfig.defaultTag ? [colorConfig.defaultTag] : [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.annotations.push(annotation);
    this.renderInBothViews(annotation);
    this.persistToSupabase(annotation);
    return annotation;
  }

  // ─── Create comment ───
  createComment(anchor: AnnotationAnchor, text: string): Annotation {
    const annotation: Annotation = {
      ...this.baseAnnotation(anchor, 'comment'),
      text,
    };
    this.annotations.push(annotation);
    this.renderInBothViews(annotation);
    this.persistToSupabase(annotation);
    return annotation;
  }

  // ─── Add tag to existing highlight or range ───
  addTag(annotationId: string, tag: string): void {
    const annotation = this.getAnnotation(annotationId);
    annotation.tags.push(tag);
    annotation.updatedAt = new Date();
    this.persistToSupabase(annotation);
  }
}
```

#### 7d. Audio Annotations (Voice Memos)

Users can record voice notes attached to specific positions in the document. This is particularly valuable for accessibility — a user listening at 700 WPM can record a quick reaction without stopping to type.

```typescript
class AudioAnnotationManager {
  private mediaRecorder: MediaRecorder | null = null;
  private recordingChunks: Blob[] = [];

  // ─── Start recording ───
  // Triggered by: 🎙 button in annotation toolbar, or keyboard shortcut (Ctrl+Shift+R),
  // or long-press on the record button in transport bar.
  // During recording, TTS playback is PAUSED (the user is speaking, not listening).
  async startRecording(anchor: AnnotationAnchor): Promise<void> {
    // Pause playback so the user's microphone doesn't pick up the TTS
    if (this.playbackController.state === 'playing') {
      this.playbackController.pause();
      this.wasPlayingBeforeRecord = true;
    }

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.mediaRecorder = new MediaRecorder(stream, {
      mimeType: 'audio/webm;codecs=opus',
    });

    this.recordingChunks = [];
    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.recordingChunks.push(e.data);
    };

    this.mediaRecorder.start();
    this.currentRecordingAnchor = anchor;

    // Show recording indicator in transport bar
    this.ui.showRecordingIndicator();
  }

  // ─── Stop recording and save ───
  async stopRecording(): Promise<Annotation> {
    return new Promise((resolve) => {
      this.mediaRecorder!.onstop = async () => {
        const audioBlob = new Blob(this.recordingChunks, { type: 'audio/webm' });
        const duration = await this.measureDuration(audioBlob);

        // Upload to Supabase Storage
        const fileName = `audio-notes/${this.userId}/${this.document.id}/${generateId()}.webm`;
        const { data } = await this.supabase.storage
          .from('annotations')
          .upload(fileName, audioBlob);

        const audioUrl = this.supabase.storage
          .from('annotations')
          .getPublicUrl(fileName).data.publicUrl;

        // Create the annotation
        const annotation: Annotation = {
          ...this.baseAnnotation(this.currentRecordingAnchor!, 'audio_note'),
          audioUrl,
          audioDurationMs: duration,
        };

        this.annotations.push(annotation);
        this.renderInBothViews(annotation);
        this.persistToSupabase(annotation);

        // Resume playback if it was playing before
        if (this.wasPlayingBeforeRecord) {
          this.playbackController.resume();
          this.wasPlayingBeforeRecord = false;
        }

        this.ui.hideRecordingIndicator();
        resolve(annotation);
      };

      this.mediaRecorder!.stop();
      this.mediaRecorder!.stream.getTracks().forEach(t => t.stop());
    });
  }

  // ─── Playback of audio annotations inline during reading ───
  // See §7e for how this integrates with the playback pipeline.
}
```

**Recording UI:** A red recording indicator appears in the transport bar with a waveform visualization and elapsed time. The user speaks their note and presses the same shortcut or button to stop. The annotation appears as a 🎙 icon in both views at the anchored position.

#### 7e. Inline Audio Annotation Playback

When the reading cursor reaches a position that has an audio annotation, the system can **play back the user's voice note inline** — TTS pauses, the audio note plays, then TTS resumes. This is configurable.

```typescript
interface AudioAnnotationPlaybackConfig {
  mode: 'inline' | 'skip' | 'earcon_only';
  // inline:     Pause TTS, play the audio note, resume TTS
  // skip:       Ignore audio notes during playback entirely
  // earcon_only: Play a brief chime when passing an audio note position,
  //              but don't pause to play the full recording

  volumeFactor: number;          // Volume of audio notes relative to TTS (default 1.0)
  crossfadeDurationMs: number;   // Fade out TTS → play note → fade in TTS (default 300)
  announceBefore: boolean;       // Say "Audio note:" before playing (default true)
  announceAfter: boolean;        // Say "End of note" after playing (default false)
}

class InlineAudioNotePlayer {
  constructor(
    private playbackController: PlaybackController,
    private stateMachine: ReadingPositionStateMachine,
    private audioGraph: AudioGraph,
    private config: AudioAnnotationPlaybackConfig,
  ) {
    // Subscribe to word-level position events
    this.stateMachine.subscribe((position, changed) => {
      if (!changed.has('word')) return;
      this.checkForAudioNote(position);
    });
  }

  private async checkForAudioNote(position: ReadingPosition): Promise<void> {
    const notesAtPosition = this.annotationManager.getAudioNotesAt(
      position.plainTextOffset
    );

    if (notesAtPosition.length === 0) return;

    switch (this.config.mode) {
      case 'skip':
        return;

      case 'earcon_only':
        this.audioGraph.playEarcon('audio-note-chime');
        return;

      case 'inline':
        for (const note of notesAtPosition) {
          await this.playInline(note);
        }
        return;
    }
  }

  private async playInline(note: Annotation): Promise<void> {
    // 1. Fade out TTS audio
    await this.audioGraph.fadeOut(this.config.crossfadeDurationMs);

    // 2. Pause the playback controller (captures snapshot)
    this.playbackController.pause();

    // 3. Optionally announce
    if (this.config.announceBefore) {
      await this.playTTSSnippet('Audio note');
    }

    // 4. Play the audio note
    const audioBuffer = await this.loadAudioNote(note.audioUrl!);
    await this.audioGraph.playBuffer(audioBuffer, {
      volume: this.config.volumeFactor,
    });

    // 5. Optionally announce end
    if (this.config.announceAfter) {
      await this.playTTSSnippet('End of note');
    }

    // 6. Resume TTS with fade in
    this.playbackController.resume();
    await this.audioGraph.fadeIn(this.config.crossfadeDurationMs);
  }
}
```

**Visual indicator during inline playback:** When an audio note is playing, the transport bar shows the note's waveform and duration, with a distinct visual style (e.g., purple background) so the user knows they're hearing their own recording, not the document. The highlight overlay shows the annotation's anchor position pulsing.

#### 7f. Annotation Extraction and Export

Annotations can be extracted in bulk for use outside Voxium — as study notes, as reference material, as a summary of marked-up passages.

```typescript
interface AnnotationExportOptions {
  format: 'markdown' | 'html' | 'json' | 'csv' | 'pdf' | 'docx';
  includeTypes: AnnotationType[];         // Which types to include
  includeColors?: string[];               // Filter by highlight color
  includeTags?: string[];                 // Filter by tag
  groupBy: 'position' | 'type' | 'color' | 'tag' | 'date';
  includeContext: boolean;                // Include surrounding text
  contextWords: number;                   // How many words of context (default 20)
  includeAudioTranscripts: boolean;       // Transcribe audio notes via Whisper
  includePageNumbers: boolean;
}

class AnnotationExporter {
  async export(options: AnnotationExportOptions): Promise<ExportResult> {
    let annotations = this.annotationManager.listAnnotations();

    // Filter
    annotations = annotations.filter(a => options.includeTypes.includes(a.type));
    if (options.includeColors) {
      annotations = annotations.filter(a => !a.color || options.includeColors!.includes(a.color));
    }
    if (options.includeTags) {
      annotations = annotations.filter(a =>
        a.tags.some(t => options.includeTags!.includes(t))
      );
    }

    // Group
    const grouped = this.groupAnnotations(annotations, options.groupBy);

    // Transcribe audio notes if requested
    if (options.includeAudioTranscripts) {
      for (const ann of annotations.filter(a => a.type === 'audio_note')) {
        ann.text = await this.transcribeAudioNote(ann);
      }
    }

    // Build context for each annotation
    if (options.includeContext) {
      for (const ann of annotations) {
        (ann as any)._context = this.getContext(ann, options.contextWords);
      }
    }

    // Render
    switch (options.format) {
      case 'markdown':
        return this.renderMarkdown(grouped, options);
      case 'html':
        return this.renderHTML(grouped, options);
      case 'json':
        return { content: JSON.stringify(grouped, null, 2), mimeType: 'application/json' };
      case 'csv':
        return this.renderCSV(annotations, options);
      case 'pdf':
        return this.renderAnnotatedPDF(annotations);
      case 'docx':
        return this.renderAnnotatedDocx(annotations);
    }
  }

  // ─── Markdown export example output ───
  // # Annotations: "The Structure of Scientific Revolutions"
  // ## 🟡 Important (12 highlights)
  //
  // > "Normal science means research firmly based upon one or more
  // > past scientific achievements" (p. 10)
  //
  // 💬 Comment: This is Kuhn's definition of the paradigm concept
  //
  // 🎙 Audio note (0:12): "I think this connects to Lakatos's
  //    research programmes — need to check chapter 4"
  //
  // ---
  //
  // > "The decision to reject one paradigm is always simultaneously
  // > the decision to accept another" (p. 77)
  //
  // 🏷 Tags: #key_finding, #paradigm_shift

  private async transcribeAudioNote(annotation: Annotation): Promise<string> {
    // Use Whisper (via Replicate or whisper-web) to transcribe
    const audioData = await this.downloadAudioNote(annotation.audioUrl!);
    const transcript = await this.whisperService.transcribe(audioData);
    return transcript.text;
  }

  // ─── Write annotations back to source document ───
  async exportToSourceFormat(
    target: 'original' | 'copy',
    format: 'pdf' | 'docx'
  ): Promise<string> {
    const outputPath = target === 'copy'
      ? this.generateCopyPath()
      : this.document.filePath;

    if (format === 'pdf') {
      // pdf-lib: add highlight annotations, text annotations (comments),
      // and attachment annotations (audio notes as embedded files)
      await this.writePDFAnnotations(outputPath);
    } else if (format === 'docx') {
      // docx library: add tracked changes, comments, and embedded audio
      await this.writeDocxAnnotations(outputPath);
    }

    // Upload to Supabase Storage
    const storagePath = `exports/${this.userId}/${this.document.id}/${Date.now()}.${format}`;
    await this.supabase.storage.from('documents').upload(storagePath, outputPath);
    return storagePath;
  }
}
```

**Annotation search:** All annotation text (comments, transcribed audio notes, selected text, tags) is indexed in Supabase full-text search. Users can search across all their annotations with queries like "find all my notes about methodology in papers tagged 'review'".

```sql
-- Full-text search across annotations
ALTER TABLE annotations ADD COLUMN fts tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english',
      coalesce(text, '') || ' ' ||
      coalesce(selected_text, '') || ' ' ||
      coalesce(array_to_string(tags, ' '), '')
    )
  ) STORED;
CREATE INDEX annotations_fts_idx ON annotations USING gin(fts);
```

#### 7g. Annotation Synchronization Between Views

Annotations created in either view are instantly reflected in the other:

```typescript
// When a highlight is created in the plain-text view:
// 1. The AST node range is resolved (startAstNodeId, endAstNodeId)
// 2. The plain-text view renders the highlight directly on the text
// 3. The original-format view looks up the bounding boxes for those AST nodes
//    and draws an SVG highlight overlay at the correct positions
// 4. If the user scrolls the original-format view, the overlay stays positioned

// When a highlight is created in the original-format view:
// 1. The click position is resolved to an AST node via bounding boxes
//    (or computer vision fallback for complex layouts)
// 2. The AST node range gives us the plain-text offsets
// 3. The plain-text view renders the highlight at those offsets
// 4. Both views stay in sync as the user navigates

// Annotations persist across sessions via Supabase.
// Supabase Realtime pushes annotation changes to other devices.
```

### 8. Image Description and Visual Aesthetic Description

Voxium Reader doesn't just skip images — it describes them. And it can describe the visual quality/aesthetic of the text formatting itself.

```typescript
interface ImageDescription {
  astNodeId: string;         // The image node in the AST
  shortDescription: string;  // "A bar chart showing quarterly revenue"
  longDescription: string;   // Detailed accessible description
  visualAesthetic?: string;  // "This image uses a warm color palette..."
}

async function describeImage(imageNode: DocumentNode): Promise<ImageDescription> {
  const imageData = await extractImageData(imageNode);

  // Use Claude vision via anthropic-mcp
  const result = await anthropicMCP.analyze({
    image: imageData,
    prompt: `Describe this image for a screen reader user.
             Provide:
             1. A concise description (one sentence)
             2. A detailed description (2-3 sentences)
             3. If this is a chart/graph, describe the data and trends
             4. Note any text visible in the image`
  });

  return parseImageDescription(result);
}

async function describeTextAesthetic(
  pageScreenshot: ImageData,
  region: BoundingBox
): Promise<string> {
  // Use Claude vision to describe visual formatting quality
  const result = await anthropicMCP.analyze({
    image: pageScreenshot,
    prompt: `Describe the visual aesthetic of the text in this region
             from a typographic and design perspective. Comment on:
             - Font choices and their effect
             - Layout and whitespace usage
             - Color scheme
             - Overall visual impression and readability
             Keep it concise — this is for a user who wants to
             understand how the document looks without seeing it.`
  });

  return result;
}
```

**When aesthetic description triggers:**
- User explicitly requests it (keyboard shortcut or menu option).
- When switching from plain-text to original-format view for the first time.
- When the speech cursor enters a new page with significantly different formatting.

---

## Data Flow: What Happens When a User Loads a Document

1. **Import:** Document is uploaded. Importer detects format, parses to AST. For PDFs, vision model analyzes layout.
2. **Structure:** Claude API segments text into clauses, sentences, paragraphs. Heading/outline tree is built.
3. **Voice Assignment:** Voice-mapping rules are applied. Each AST node gets a voiceId.
4. **Block Creation:** Text segmenter creates speech blocks based on paragraph/voice boundaries.
5. **Synthesis (block 1):** HeadTTS synthesizes the first block. Word timings are returned.
6. **Stretch + Simulate (block 1):** Libsonic stretches to current speed. Simulation measures actual output durations word-by-word — no estimation.
7. **Playback begins.** Highlighting engine starts tracking word timings.
8. **Prefetch:** Blocks 2-6 are synthesized and stretched in background.
9. **Background:** Remaining blocks queue for generation.
10. **Caching:** Completed blocks are uploaded to GCS for future sessions.

## Data Flow: What Happens When a User Clicks in Either View

All user-initiated position changes — clicking to start, clicking mid-playback, tapping a word, clicking the progress bar, using keyboard navigation — funnel through a single **PlaybackController** that guarantees consistent state transitions. The system never assumes playback starts at the beginning. It never assumes the user is currently playing. Every seek operation is safe from any state.

### 9. Playback Controller

The PlaybackController is the single entry point for all playback state transitions. Nothing else directly touches the Web Audio graph, the AudioWorklet emitter, or the state machine — they all go through here.

```typescript
type PlaybackState =
  | 'idle'           // Document loaded, nothing playing, no position
  | 'positioned'     // Cursor is at a specific word, but not playing
  | 'loading'        // User requested play/seek but the block isn't ready yet
  | 'playing'        // Audio is actively playing
  | 'paused'         // Audio paused, position preserved exactly
  | 'seeking'        // Transitioning between positions (mid-playback or from paused)
  | 'error';         // Something went wrong, user can retry

interface PlaybackSnapshot {
  state: PlaybackState;
  documentId: string;
  astNodeId: string;                  // Current word node
  blockId: string;
  sampleOffsetInBlock: number;        // Exact sample position within the block
  speedFactor: number;
  timestamp: Date;                    // When this snapshot was taken
  progressPercent: number;
}

class PlaybackController {
  private state: PlaybackState = 'idle';
  private audioGraph: WebAudioGraph;
  private blockBuffer: BlockBufferManager;
  private stateMachine: ReadingPositionStateMachine;
  private emitter: BoundaryEmitterWorklet;
  private scheduler: PredictiveHighlightScheduler;
  private currentSnapshot: PlaybackSnapshot | null = null;

  // ──────────────────────────────────────────────────────────
  // SCENARIO 1: User clicks anywhere to begin playback
  //             (from idle, positioned, or paused state)
  // ──────────────────────────────────────────────────────────
  async playFromPosition(astNodeId: string) {
    const previousState = this.state;

    // Guard: If already playing, this is a seek (Scenario 2)
    if (this.state === 'playing') {
      return this.seekDuringPlayback(astNodeId);
    }

    // Guard: If already seeking/loading, ignore rapid clicks
    if (this.state === 'seeking' || this.state === 'loading') {
      return;
    }

    this.state = 'loading';
    this.emitStateChange();

    try {
      // 1. Find which block contains this word
      const wordNode = this.ast.getNode(astNodeId);
      const block = this.blockBuffer.findBlockContaining(astNodeId);

      // 2. Ensure the block is ready (synthesized + simulated)
      if (block.status !== 'ready') {
        // Show loading indicator on the clicked word
        this.highlightEngine.showLoadingIndicator(astNodeId);
        await this.blockBuffer.generateBlock(block, 'immediate');
      }

      // 3. Find the exact sample offset for this word within the block
      const wordTiming = block.wordTimings.find(
        w => w.astNodeId === astNodeId
      );
      if (!wordTiming) {
        // Fallback: snap to the nearest word in this block
        const nearest = this.findNearestWord(block, wordNode.plainTextRange[0]);
        return this.playFromPosition(nearest.astNodeId);
      }

      const sampleOffset = Math.round(
        wordTiming.startMs * this.audioGraph.sampleRate / 1000
      );

      // 4. Tear down any existing audio source cleanly
      this.audioGraph.stopAndDisconnect();

      // 5. Load the block's audio into the Web Audio graph,
      //    starting from the word's sample offset
      this.audioGraph.loadBuffer(block.audioBuffer, sampleOffset);

      // 6. Load the block's timing array into the AudioWorklet emitter,
      //    seeked to the correct position
      this.emitter.postMessage({
        command: 'loadTimings',
        timings: this.buildTimingEntries(block),
        blockId: block.id,
      });
      this.emitter.postMessage({
        command: 'seek',
        sampleOffset: sampleOffset,
      });

      // 7. Pre-schedule highlights from this word onward
      const wordIndex = block.wordTimings.indexOf(wordTiming);
      this.scheduler.onBlockStartFromWord(
        block.wordTimings,
        wordIndex,
        performance.now()
      );

      // 8. Update the state machine to this position immediately
      //    (don't wait for the first AudioWorklet event)
      this.stateMachine.setPositionImmediate(astNodeId, block.id);

      // 9. Start playback
      this.audioGraph.play();
      this.state = 'playing';
      this.emitStateChange();

      // 10. Prefetch adjacent blocks
      this.blockBuffer.prefetchOutward(block.id, 5);

    } catch (error) {
      this.state = previousState === 'paused' ? 'paused' : 'idle';
      this.emitStateChange();
      this.handleError(error, 'playFromPosition');
    }
  }

  // ──────────────────────────────────────────────────────────
  // SCENARIO 2: User clicks a different word while already playing
  //             (mid-playback seek)
  // ──────────────────────────────────────────────────────────
  async seekDuringPlayback(astNodeId: string) {
    // Guard: Debounce rapid clicks (ignore if already seeking)
    if (this.state === 'seeking') return;

    const wasPlaying = this.state === 'playing';
    this.state = 'seeking';
    this.emitStateChange();

    try {
      // 1. Immediately stop current audio to prevent hearing "old" audio
      //    while seeking. This is critical — the user should never hear
      //    audio from the old position after clicking a new one.
      this.audioGraph.stopImmediately();

      // 2. Cancel all pre-scheduled highlight transitions
      this.scheduler.cancelAllScheduled();

      // 3. Stop the AudioWorklet emitter from firing stale events
      this.emitter.postMessage({ command: 'stop' });

      // 4. Snap the highlight to the clicked word immediately
      //    (visual feedback before audio is ready)
      this.stateMachine.setPositionImmediate(astNodeId);
      this.highlightEngine.snapToWord(astNodeId);

      // 5. Determine if the target word is in the same block or different
      const targetBlock = this.blockBuffer.findBlockContaining(astNodeId);
      const currentBlock = this.blockBuffer.getCurrentBlock();

      if (targetBlock.id === currentBlock.id && targetBlock.status === 'ready') {
        // Same block: just seek within it (fast path)
        const wordTiming = targetBlock.wordTimings.find(
          w => w.astNodeId === astNodeId
        );
        const sampleOffset = Math.round(
          wordTiming!.startMs * this.audioGraph.sampleRate / 1000
        );

        this.audioGraph.loadBuffer(targetBlock.audioBuffer, sampleOffset);
        this.emitter.postMessage({
          command: 'loadTimings',
          timings: this.buildTimingEntries(targetBlock),
          blockId: targetBlock.id,
        });
        this.emitter.postMessage({ command: 'seek', sampleOffset });

        const wordIndex = targetBlock.wordTimings.indexOf(wordTiming!);
        this.scheduler.onBlockStartFromWord(
          targetBlock.wordTimings, wordIndex, performance.now()
        );

      } else {
        // Different block: need to load it
        if (targetBlock.status !== 'ready') {
          this.highlightEngine.showLoadingIndicator(astNodeId);
          await this.blockBuffer.generateBlock(targetBlock, 'immediate');
        }

        const wordTiming = targetBlock.wordTimings.find(
          w => w.astNodeId === astNodeId
        );
        const sampleOffset = Math.round(
          wordTiming!.startMs * this.audioGraph.sampleRate / 1000
        );

        this.audioGraph.loadBuffer(targetBlock.audioBuffer, sampleOffset);
        this.emitter.postMessage({
          command: 'loadTimings',
          timings: this.buildTimingEntries(targetBlock),
          blockId: targetBlock.id,
        });
        this.emitter.postMessage({ command: 'seek', sampleOffset });

        const wordIndex = targetBlock.wordTimings.indexOf(wordTiming!);
        this.scheduler.onBlockStartFromWord(
          targetBlock.wordTimings, wordIndex, performance.now()
        );

        // Re-prefetch from new position
        this.blockBuffer.prefetchOutward(targetBlock.id, 5);
      }

      // 6. Resume playback if we were playing before the seek
      if (wasPlaying) {
        this.audioGraph.play();
        this.state = 'playing';
      } else {
        this.state = 'positioned';
      }
      this.emitStateChange();

    } catch (error) {
      // On error during seek, pause at the last known good position
      this.state = 'paused';
      this.emitStateChange();
      this.handleError(error, 'seekDuringPlayback');
    }
  }

  // ──────────────────────────────────────────────────────────
  // SCENARIO 3: User pauses playback
  // ──────────────────────────────────────────────────────────
  pause() {
    if (this.state !== 'playing') return;

    // 1. Pause the Web Audio graph (preserves exact sample position)
    this.audioGraph.pause();

    // 2. Cancel pre-scheduled highlight transitions
    this.scheduler.cancelAllScheduled();

    // 3. The AudioWorklet emitter automatically stops firing
    //    because no samples are flowing through it.
    //    (AudioWorklet.process() still gets called but with
    //    silence, so the sample counter doesn't advance.)

    // 4. Capture a snapshot for resume/restore
    this.currentSnapshot = this.captureSnapshot();

    // 5. Persist the snapshot to Supabase for cross-session restore
    this.persistSnapshot(this.currentSnapshot);

    this.state = 'paused';
    this.emitStateChange();
  }

  // ──────────────────────────────────────────────────────────
  // SCENARIO 4: User resumes from pause (same session)
  // ──────────────────────────────────────────────────────────
  resume() {
    if (this.state !== 'paused' && this.state !== 'positioned') return;

    // Guard: If we have a snapshot, verify the block is still loaded
    if (this.currentSnapshot) {
      const block = this.blockBuffer.getBlock(this.currentSnapshot.blockId);
      if (!block || block.status !== 'ready') {
        // Block was evicted from memory — regenerate and play from snapshot
        return this.restoreFromSnapshot(this.currentSnapshot);
      }
    }

    // Re-schedule highlights for the remaining words in the current block
    const position = this.stateMachine.getPosition();
    const block = this.blockBuffer.getBlock(position.blockId);
    if (block) {
      const currentWordIndex = block.wordTimings.findIndex(
        w => w.astNodeId === position.word.astNodeId
      );
      if (currentWordIndex >= 0) {
        this.scheduler.onBlockStartFromWord(
          block.wordTimings, currentWordIndex, performance.now()
        );
      }
    }

    // Resume audio from exact paused position
    this.audioGraph.resume();
    this.state = 'playing';
    this.emitStateChange();
  }

  // ──────────────────────────────────────────────────────────
  // SCENARIO 5: User returns to document later (cross-session restore)
  // ──────────────────────────────────────────────────────────
  async restoreFromSnapshot(snapshot: PlaybackSnapshot) {
    this.state = 'loading';
    this.emitStateChange();

    try {
      // 1. Verify the document hasn't changed since the snapshot
      const currentDocHash = this.document.hash;
      if (snapshot.documentId !== this.document.id) {
        // Wrong document — discard snapshot, go to idle
        this.state = 'idle';
        this.emitStateChange();
        return;
      }

      // 2. Verify the AST node still exists
      //    (document may have been re-imported with slightly different parsing)
      let targetNodeId = snapshot.astNodeId;
      if (!this.ast.hasNode(targetNodeId)) {
        // Node was removed — find the nearest surviving node
        // by matching the plain text offset from the snapshot
        targetNodeId = this.ast.findNearestNodeByOffset(
          snapshot.progressPercent * this.ast.totalCharacters / 100
        )?.id ?? this.ast.getFirstWordNode().id;
      }

      // 3. Restore speed setting
      if (snapshot.speedFactor !== this.blockBuffer.currentSpeed) {
        await this.blockBuffer.onSpeedChange(snapshot.speedFactor);
      }

      // 4. Position at the restored word (but don't auto-play)
      const block = this.blockBuffer.findBlockContaining(targetNodeId);
      if (block.status !== 'ready') {
        this.highlightEngine.showLoadingIndicator(targetNodeId);
        await this.blockBuffer.generateBlock(block, 'immediate');
      }

      // 5. Set up highlighting at the restored position
      this.stateMachine.setPositionImmediate(targetNodeId, block.id);
      this.highlightEngine.snapToWord(targetNodeId);

      // 6. Scroll the view to make the restored position visible
      this.viewManager.scrollToNode(targetNodeId);

      // 7. Prefetch adjacent blocks
      this.blockBuffer.prefetchOutward(block.id, 5);

      // 8. Go to 'positioned' state — user can tap play to resume,
      //    or click elsewhere to change position first
      this.state = 'positioned';
      this.emitStateChange();

    } catch (error) {
      this.state = 'idle';
      this.emitStateChange();
      this.handleError(error, 'restoreFromSnapshot');
    }
  }

  // ──────────────────────────────────────────────────────────
  // SNAPSHOT MANAGEMENT
  // ──────────────────────────────────────────────────────────

  private captureSnapshot(): PlaybackSnapshot {
    const position = this.stateMachine.getPosition();
    const block = this.blockBuffer.getBlock(position.blockId);

    // Compute exact sample offset from the state machine's
    // last confirmed audio timestamp
    const wordTiming = block?.wordTimings.find(
      w => w.astNodeId === position.word.astNodeId
    );
    const sampleOffset = wordTiming
      ? Math.round(wordTiming.startMs * this.audioGraph.sampleRate / 1000)
      : 0;

    return {
      state: this.state,
      documentId: this.document.id,
      astNodeId: position.word.astNodeId,
      blockId: position.blockId,
      sampleOffsetInBlock: sampleOffset,
      speedFactor: this.blockBuffer.currentSpeed,
      timestamp: new Date(),
      progressPercent: position.progressPercent,
    };
  }

  private async persistSnapshot(snapshot: PlaybackSnapshot) {
    // Write to Supabase reading_positions table
    // Keyed by (userId, documentId) — one active snapshot per document
    await this.supabase.from('reading_positions').upsert({
      document_id: snapshot.documentId,
      user_id: this.userId,
      ast_node_id: snapshot.astNodeId,
      block_id: snapshot.blockId,
      sample_offset: snapshot.sampleOffsetInBlock,
      speed_factor: snapshot.speedFactor,
      progress_percent: snapshot.progressPercent,
    });
  }

  // Called when the app loads and a document is opened
  async checkForSavedPosition(documentId: string): Promise<PlaybackSnapshot | null> {
    const { data: saved } = await this.supabase
      .from('reading_positions')
      .select()
      .eq('document_id', documentId)
      .eq('user_id', this.userId)
      .single();
    if (!saved) return null;

    return {
      ...saved,
      timestamp: new Date(saved.timestamp),
    };
  }

  // ──────────────────────────────────────────────────────────
  // GUARDRAILS
  // ──────────────────────────────────────────────────────────

  private emitStateChange() {
    // Notify UI of state changes (for play/pause button, loading spinners, etc.)
    this.stateListeners.forEach(l => l(this.state));
  }

  private handleError(error: unknown, context: string) {
    console.error(`PlaybackController.${context}:`, error);
    // Don't crash — show user-friendly error in UI
    // Offer retry from last known good position
    this.errorListeners.forEach(l => l(error, context, this.currentSnapshot));
  }
}
```

**State transition guardrails:**

```
                        ┌──────────────┐
              ┌────────→│     idle     │←─── document load / error recovery
              │         └──────┬───────┘
              │                │ click word / restore saved position
              │                ▼
              │         ┌──────────────┐
              │    ┌───→│  positioned  │←─── restore complete / seek while paused
              │    │    └──────┬───────┘
              │    │           │ press play / click word
              │    │           ▼
              │    │    ┌──────────────┐
              │    │    │   loading    │←─── block not ready yet
              │    │    └──────┬───────┘
              │    │           │ block ready
              │    │           ▼
              │    │    ┌──────────────┐
              │    ├────│   playing    │←─── resume / seek complete (was playing)
              │    │    └──┬───┬───┬───┘
              │    │       │   │   │
              │    │  pause│   │   │click word (different position)
              │    │       │   │   │
              │    │       ▼   │   ▼
              │    │  ┌──────┐ │ ┌──────────────┐
              │    └──│paused│ │ │   seeking    │
              │       └──────┘ │ └──────┬───────┘
              │                │        │ seek complete
              │                │        ├──→ playing (if was playing)
              │                │        └──→ positioned (if was paused)
              │                │
              │                │ block_end event (last block in document)
              │                ▼
              │         ┌──────────────┐
              └─────────│  idle / done │
                        └──────────────┘
```

**Rules enforced by the state machine:**

1. **No action is ever ignored silently.** Every click either transitions state or is debounced with visual feedback (e.g., loading spinner on the clicked word).
2. **Rapid clicks during `seeking` or `loading` are debounced.** The first click wins. Subsequent clicks within the transition window are queued — the last one executes when the current transition completes.
3. **Audio from the old position never leaks.** `seekDuringPlayback` calls `stopImmediately()` before doing anything else. The user never hears audio from position A after clicking position B.
4. **Visual feedback is always immediate.** Even if the target block needs synthesis, the highlight snaps to the clicked word instantly and shows a loading indicator. The user always knows the system registered their click.
5. **Pause captures an exact snapshot.** Not "roughly where we were" — the exact AST node, exact sample offset, exact speed setting. Resume from pause is sample-accurate.
6. **Cross-session restore is defensive.** The snapshot includes the document ID and the AST node ID. On restore, the system verifies both still exist. If the document was re-imported and the AST changed, it finds the nearest surviving node by text offset. If the document is gone entirely, it goes to `idle` gracefully.
7. **Errors never leave the system in an inconsistent state.** Every `try/catch` block explicitly sets a safe fallback state (`paused` or `idle`) and offers the user a retry path from the last known good snapshot.
8. **Block eviction is handled.** If the user pauses for a long time and the browser reclaims memory, the block that was playing may no longer be in RAM. Resume detects this and regenerates the block from cached raw audio (or re-synthesizes from GCS cache) before resuming.

### Auto-Save Reading Position

The system automatically persists the reading position at multiple granularities:

```typescript
// Subscribe to the state machine for auto-save triggers
stateMachine.subscribe((position, changed) => {
  // Save to Supabase every paragraph change (~5-10 seconds at speed)
  if (changed.has('paragraph')) {
    playbackController.persistSnapshot(
      playbackController.captureSnapshot()
    );
  }
});

// Also save on:
// - Pause (explicit in pause() method above)
// - Tab/window blur (user switches away)
window.addEventListener('visibilitychange', () => {
  if (document.hidden && playbackController.state === 'playing') {
    playbackController.pause();  // Pause also persists snapshot
  }
});

// - beforeunload (user closes tab)
window.addEventListener('beforeunload', () => {
  if (playbackController.state === 'playing' ||
      playbackController.state === 'paused') {
    // Synchronous write to localStorage as backup
    // (Supabase write may not complete before unload)
    localStorage.setItem(
      `voxium-position-${documentId}`,
      JSON.stringify(playbackController.captureSnapshot())
    );
  }
});
```

**On document open, the restore flow is:**

1. Check localStorage for a backup snapshot (handles unclean shutdown).
2. Check Supabase for the canonical saved position.
3. Use whichever is more recent.
4. Show the user: "You were reading at [paragraph summary]. Resume here?" with options to resume or start from beginning.
5. If the user confirms, call `restoreFromSnapshot()`.
6. If the user declines, go to `idle`.

---

## 10. Navigation and Transport Controls

Voxium Reader provides Voice Dream Reader-caliber navigation controls. All transport actions route through the PlaybackController (§9) and all position awareness comes from the Playback Awareness Layer (§4a), ensuring consistent state regardless of how the user triggers an action.

### 10a. Navigation Units

The core navigation concept borrowed from Voice Dream Reader: a user-configurable **navigation unit** that determines what "rewind" and "fast forward" mean at any moment.

```typescript
type NavigationUnit =
  | 'word'
  | 'clause'
  | 'sentence'
  | 'paragraph'
  | 'page'
  | 'section'        // Chapter / heading-level division
  | 'bookmark'       // Jump to next/previous user bookmark
  | 'highlight'      // Jump to next/previous user highlight
  | 'time_15s'
  | 'time_30s'
  | 'time_60s';

interface NavigationState {
  currentUnit: NavigationUnit;          // User's active navigation unit
  rewindUnit: NavigationUnit;           // Can be set independently from forward
  forwardUnit: NavigationUnit;          // Can be set independently from rewind
  independentRewindForward: boolean;    // Whether rewind/forward use separate units
}
```

**Improvement over Voice Dream Reader:** The user can optionally set rewind and fast-forward to use *different* navigation units. (Voice Dream Reader users have requested this — wanting to rewind by sentence but fast-forward by paragraph.) When `independentRewindForward` is false (default), both use `currentUnit`.

### 10b. Transport Bar

The transport bar is the primary control surface, always visible at the bottom of both views:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                         │
│  ◀◀ Prev    ⏪ Rewind    ▶ Play/Pause    ⏩ Forward    ▶▶ Next        │
│  [doc]      [nav unit]                    [nav unit]    [doc]           │
│                                                                         │
│  ├──────────────●────────────────────────────────────────────────┤      │
│  0%            23%         Progress Scrubber                   100%     │
│                                                                         │
│  🔊 Speed: 3.2x (480 WPM)          📍 Nav Unit: Sentence  ▼          │
│  Page 14 of 203  ·  Chapter 3: Methods  ·  38% complete                │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

**Button behaviors:**

| Button | Tap | Long-press |
|---|---|---|
| **Play/Pause** | Toggle play ↔ pause | Show sleep timer options |
| **Rewind** | Jump back by current rewind navigation unit | Show navigation unit picker (selection also executes the rewind) |
| **Forward** | Jump forward by current forward navigation unit | Show navigation unit picker (selection also executes the forward) |
| **Prev** | Go to previous document in playlist/library | — |
| **Next** | Go to next document in playlist/library | — |

**Navigation unit execution:**

```typescript
class NavigationController {
  private playbackController: PlaybackController;
  private stateMachine: ReadingPositionStateMachine;
  private ast: DocumentAST;
  private navState: NavigationState;

  async rewind() {
    const unit = this.navState.independentRewindForward
      ? this.navState.rewindUnit
      : this.navState.currentUnit;
    const targetNode = this.findPreviousBoundary(unit);
    if (targetNode) {
      await this.playbackController.seekToNode(targetNode.id);
    }
  }

  async forward() {
    const unit = this.navState.independentRewindForward
      ? this.navState.forwardUnit
      : this.navState.currentUnit;
    const targetNode = this.findNextBoundary(unit);
    if (targetNode) {
      await this.playbackController.seekToNode(targetNode.id);
    }
  }

  private findPreviousBoundary(unit: NavigationUnit): DocumentNode | null {
    const currentPos = this.stateMachine.getPosition();

    switch (unit) {
      case 'word':
        return this.ast.getPreviousWord(currentPos.word.astNodeId);

      case 'clause':
        return this.ast.getFirstWordOf(
          this.ast.getPreviousSibling(currentPos.clause.astNodeId, 'clause')
        );

      case 'sentence':
        // Smart rewind: if we're more than 2 words into the current sentence,
        // go to the start of THIS sentence. Otherwise go to the previous one.
        const currentSentenceStart = this.ast.getFirstWordOf(
          currentPos.sentence.astNodeId
        );
        const wordsIntoSentence = this.ast.wordsBetween(
          currentSentenceStart.id, currentPos.word.astNodeId
        );
        if (wordsIntoSentence > 2) {
          return currentSentenceStart;
        }
        return this.ast.getFirstWordOf(
          this.ast.getPreviousSibling(currentPos.sentence.astNodeId, 'sentence')
        );

      case 'paragraph':
        // Same smart logic: if near the start of the current paragraph,
        // go to the previous one. Otherwise go to the start of this one.
        const currentParaStart = this.ast.getFirstWordOf(
          currentPos.paragraph.astNodeId
        );
        const wordsIntoPara = this.ast.wordsBetween(
          currentParaStart.id, currentPos.word.astNodeId
        );
        if (wordsIntoPara > 5) {
          return currentParaStart;
        }
        return this.ast.getFirstWordOf(
          this.ast.getPreviousSibling(currentPos.paragraph.astNodeId, 'paragraph')
        );

      case 'page':
        return this.ast.getFirstWordOfPage(
          this.ast.getPageNumber(currentPos.word.astNodeId) - 1
        );

      case 'section':
        return this.ast.getFirstWordOf(
          this.ast.getPreviousSection(currentPos.section.astNodeId)
        );

      case 'bookmark':
        return this.bookmarkManager.getPreviousBookmark(
          currentPos.plainTextOffset
        )?.firstWordNode;

      case 'highlight':
        return this.annotationManager.getPreviousHighlight(
          currentPos.plainTextOffset
        )?.firstWordNode;

      case 'time_15s':
      case 'time_30s':
      case 'time_60s':
        const seconds = unit === 'time_15s' ? 15 : unit === 'time_30s' ? 30 : 60;
        return this.findWordAtTimeOffset(-seconds);
    }
  }

  // Time-based navigation uses the simulated block timings to find
  // which word corresponds to N seconds back/forward from current position.
  private findWordAtTimeOffset(offsetSeconds: number): DocumentNode | null {
    const currentPos = this.stateMachine.getPosition();
    let remainingMs = Math.abs(offsetSeconds) * 1000;
    const direction = offsetSeconds < 0 ? 'backward' : 'forward';

    // Walk through blocks accumulating duration until we've covered
    // the target time offset, then find the word within that block.
    let blockId = currentPos.blockId;
    let wordTimingIndex = this.getCurrentWordIndex(currentPos);

    while (remainingMs > 0) {
      const block = this.blockBuffer.getBlock(blockId);
      if (!block || block.status !== 'ready') break;

      if (direction === 'backward') {
        // Walk backward through word timings in this block
        while (wordTimingIndex >= 0 && remainingMs > 0) {
          remainingMs -= block.wordTimings[wordTimingIndex].durationMs;
          if (remainingMs <= 0) {
            return this.ast.getNode(block.wordTimings[wordTimingIndex].astNodeId);
          }
          wordTimingIndex--;
        }
        // Move to previous block
        const prevBlock = this.blockBuffer.getPreviousBlock(blockId);
        if (!prevBlock) break;
        blockId = prevBlock.id;
        wordTimingIndex = prevBlock.wordTimings.length - 1;
      } else {
        // Walk forward through word timings
        while (wordTimingIndex < block.wordTimings.length && remainingMs > 0) {
          remainingMs -= block.wordTimings[wordTimingIndex].durationMs;
          if (remainingMs <= 0) {
            return this.ast.getNode(block.wordTimings[wordTimingIndex].astNodeId);
          }
          wordTimingIndex++;
        }
        const nextBlock = this.blockBuffer.getNextBlock(blockId);
        if (!nextBlock) break;
        blockId = nextBlock.id;
        wordTimingIndex = 0;
      }
    }

    // Clamp to document start/end
    return direction === 'backward'
      ? this.ast.getFirstWordNode()
      : this.ast.getLastWordNode();
  }

  // Time-based rewind snaps to sentence start when close.
  // Voice Dream Reader does this: "When you rewind 30 seconds,
  // the app will start reading from the beginning of a full
  // sentence if it's close enough."
  private snapToSentenceStart(wordNode: DocumentNode): DocumentNode {
    const sentence = this.ast.findAncestor(wordNode, 'sentence');
    const sentenceStart = this.ast.getFirstWordOf(sentence);
    const wordsFromStart = this.ast.wordsBetween(sentenceStart.id, wordNode.id);
    // If within 3 words of a sentence start, snap to it
    if (wordsFromStart <= 3) {
      return sentenceStart;
    }
    return wordNode;
  }
}
```

### 10c. Speed Controls

```typescript
interface SpeedControlConfig {
  min: number;              // 0.5x (75 WPM)
  max: number;              // 6.0x (900 WPM)
  step: number;             // 0.1x per increment
  fineStep: number;         // 0.05x for fine adjustment (shift+key)
  presets: number[];         // Quick-access speed buttons
  currentSpeed: number;
  rampingEnabled: boolean;   // Gradual acceleration on play
  rampDurationMs: number;    // How long to ramp from 1x to target speed
}

const DEFAULT_SPEED_CONFIG: SpeedControlConfig = {
  min: 0.5,
  max: 6.0,
  step: 0.1,
  fineStep: 0.05,
  presets: [1.0, 1.5, 2.0, 3.0, 4.0, 5.0, 6.0],
  currentSpeed: 1.0,
  rampingEnabled: false,
  rampDurationMs: 3000,
};
```

**Speed display:** Always shown in both multiplier (3.2x) and approximate WPM (480 WPM). The WPM is computed from actual measured reading speed via the state machine's word-timing events, not estimated from the speed factor — consistent with the simulation-not-estimation principle.

**Speed ramping:** Optional feature. When enabled, playback starts at 1x and gradually accelerates to the target speed over `rampDurationMs`. This helps the listener's ear adjust, especially when resuming at very high speeds. Implemented by feeding the speed value as a parameter change to the libsonic WASM stream over successive blocks.

### 10d. Progress Scrubber

The progress bar at the bottom is a draggable scrubber that maps document position visually:

```typescript
interface ScrubberState {
  totalDurationMs: number;          // Estimated total at current speed
  currentPositionMs: number;        // Current position as time
  currentPercent: number;           // 0-100 from state machine
  pageNumber: number;
  totalPages: number;
  chapterName: string;
  isDragging: boolean;
  previewWord: string | null;       // Show word under scrubber thumb while dragging
}
```

**While dragging:** The scrubber shows a tooltip with the word/sentence at the dragged position. The highlight snaps to the preview position in real-time. Audio is muted during drag. On release, the PlaybackController seeks to the final position and resumes playback if it was playing.

**Tap on progress bar:** Seek directly to that position (routes through PlaybackController.seekDuringPlayback or playFromPosition depending on state).

**Go-to controls:** Tapping the page number, percentage, or chapter name in the footer opens a quick-jump dialog:

```typescript
interface GoToOptions {
  type: 'page' | 'percent' | 'chapter' | 'heading' | 'search';
  value: number | string;
}
```

### 10e. Bookmarks

```typescript
interface Bookmark {
  id: string;
  documentId: string;
  astNodeId: string;               // The word where the bookmark is placed
  plainTextOffset: number;
  label: string;                   // Auto-generated or user-edited
  color: string;
  createdAt: Date;
  pageNumber?: number;
  chapterName?: string;
}

class BookmarkManager {
  // Create bookmark at current reading position
  addBookmarkAtCurrentPosition(label?: string): Bookmark {
    const position = this.stateMachine.getPosition();
    const node = this.ast.getNode(position.word.astNodeId);
    const autoLabel = label ?? this.generateLabel(node);
    // e.g., "Ch. 3 — '...the fundamental question of...' — p.14"

    const bookmark: Bookmark = {
      id: generateId(),
      documentId: this.document.id,
      astNodeId: position.word.astNodeId,
      plainTextOffset: position.plainTextOffset,
      label: autoLabel,
      color: '#FF6B6B',
      createdAt: new Date(),
      pageNumber: this.ast.getPageNumber(position.word.astNodeId),
      chapterName: this.ast.getChapterName(position.word.astNodeId),
    };

    this.bookmarks.push(bookmark);
    this.persistToSupabase(bookmark);
    return bookmark;
  }

  // Navigate to bookmark (used by rewind/forward with unit='bookmark')
  getNextBookmark(fromOffset: number): Bookmark | null {
    return this.bookmarks
      .filter(b => b.plainTextOffset > fromOffset)
      .sort((a, b) => a.plainTextOffset - b.plainTextOffset)[0] ?? null;
  }

  getPreviousBookmark(fromOffset: number): Bookmark | null {
    return this.bookmarks
      .filter(b => b.plainTextOffset < fromOffset)
      .sort((a, b) => b.plainTextOffset - a.plainTextOffset)[0] ?? null;
  }

  // List all bookmarks (for bookmark panel/sidebar)
  listBookmarks(): Bookmark[] {
    return [...this.bookmarks].sort(
      (a, b) => a.plainTextOffset - b.plainTextOffset
    );
  }
}
```

Bookmarks are stored in Supabase and synced across devices via Realtime. They appear as markers on the progress scrubber and in the Outline Sidebar alongside heading navigation.

### 10f. Sleep Timer

```typescript
interface SleepTimerConfig {
  enabled: boolean;
  mode: 'duration' | 'end_of_chapter' | 'end_of_section';
  durationMinutes?: number;          // For 'duration' mode
  options: number[];                  // Quick-select: [5, 10, 15, 30, 45, 60]
  fadeOutDurationMs: number;          // Gradual volume fade before stopping
  remainingMs: number;                // Countdown
}

class SleepTimer {
  start(config: SleepTimerConfig) {
    if (config.mode === 'duration') {
      this.remainingMs = config.durationMinutes! * 60 * 1000;
      this.startCountdown();
    } else {
      // Subscribe to state machine for chapter/section end
      this.stateMachine.subscribe((position, changed) => {
        if (config.mode === 'end_of_chapter' && changed.has('section')) {
          this.triggerSleep();
        }
      });
    }
  }

  private triggerSleep() {
    // Fade out volume over fadeOutDurationMs
    this.audioGraph.fadeOut(this.config.fadeOutDurationMs);
    setTimeout(() => {
      this.playbackController.pause();  // Pause captures snapshot
    }, this.config.fadeOutDurationMs);
  }
}
```

**Activation:** Long-press the Play/Pause button to show sleep timer options. A clock icon appears in the footer when active, showing remaining time. Tap the icon to cancel.

### 10g. Focused Reading Mode

A distraction-free mode that reduces the visible text area and auto-scrolls to keep the current word centered:

```typescript
interface FocusedReadingConfig {
  enabled: boolean;
  visibleLines: number;          // How many lines of text to show (default: 3-5)
  autoScroll: boolean;           // Keep spoken word centered vertically
  dimSurrounding: boolean;       // Dim text outside the focused region
  dimOpacity: number;            // 0.1-0.5
  hideControls: boolean;         // Auto-hide transport bar (show on tap)
}
```

**Activation:** Pinch gesture (two-finger pinch inward) or keyboard shortcut or menu toggle. Un-pinch or press Escape to exit.

**Behavior:** The view narrows to show only a few lines around the current word. Text outside the focused region is dimmed or hidden. The view auto-scrolls smoothly so the spoken line is always centered. Transport controls auto-hide after 3 seconds but reappear on any tap/mouse movement.

### 10h. Pronunciation Dictionary

A per-language dictionary of pronunciation overrides, consistent with Voice Dream Reader's approach:

```typescript
interface PronunciationRule {
  id: string;
  searchText: string;
  matchMode: 'word' | 'anywhere' | 'regex';
  ignoreCase: boolean;
  action: 'pronounce_as' | 'skip';
  replacement?: string;           // For 'pronounce_as' — phonetic or alternate text
  language: string;               // Rules are per-language
}

// Example rules:
const exampleRules: PronunciationRule[] = [
  {
    id: '1',
    searchText: 'lol',
    matchMode: 'word',
    ignoreCase: true,
    action: 'pronounce_as',
    replacement: 'laughing out loud',
    language: 'en',
  },
  {
    id: '2',
    searchText: 'Moby Dick',
    matchMode: 'anywhere',
    ignoreCase: false,
    action: 'skip',              // Skip the title repeated on every page
    language: 'en',
  },
  {
    id: '3',
    searchText: '[0-9]+:[0-9]+',
    matchMode: 'regex',
    ignoreCase: false,
    action: 'skip',              // Skip Bible chapter:verse numbers
    language: 'en',
  },
];
```

**How it integrates with the pipeline:** Pronunciation rules are applied during text segmentation (before HeadTTS synthesis). The segmenter preprocesses each block's text against the active rules, replacing or removing matched text. The AST retains the original text for display — only the text sent to HeadTTS is modified.

Rules are stored in Supabase per user per language and sync across devices via Realtime.

### 10i. Keyboard, Gesture, and Media Key Mappings

All controls are accessible via keyboard shortcuts, touch gestures, and hardware media keys (Bluetooth headphones, keyboard media keys):

```typescript
interface InputMapping {
  action: PlaybackAction;
  keyboard?: string;           // Key combo, e.g., 'Space', 'Ctrl+Left'
  gesture?: string;            // Touch gesture description
  mediaKey?: string;           // Media Session API action
}

type PlaybackAction =
  | 'play_pause'
  | 'rewind'
  | 'forward'
  | 'speed_up'
  | 'speed_down'
  | 'speed_up_fine'
  | 'speed_down_fine'
  | 'next_document'
  | 'previous_document'
  | 'toggle_focused_mode'
  | 'add_bookmark'
  | 'go_to_page'
  | 'go_to_chapter'
  | 'toggle_view'             // Plain text ↔ original format
  | 'cycle_nav_unit'
  | 'set_nav_unit_sentence'
  | 'set_nav_unit_paragraph'
  | 'set_nav_unit_page'
  | 'set_nav_unit_chapter';

const DEFAULT_MAPPINGS: InputMapping[] = [
  // --- Playback ---
  { action: 'play_pause',       keyboard: 'Space',         gesture: 'two-finger double-tap', mediaKey: 'play' },
  { action: 'rewind',           keyboard: 'ArrowLeft',     gesture: 'two-finger swipe-left', mediaKey: 'previoustrack' },
  { action: 'forward',          keyboard: 'ArrowRight',    gesture: 'two-finger swipe-right', mediaKey: 'nexttrack' },

  // --- Speed ---
  { action: 'speed_up',         keyboard: 'ArrowUp',       gesture: 'two-finger swipe-up' },
  { action: 'speed_down',       keyboard: 'ArrowDown',     gesture: 'two-finger swipe-down' },
  { action: 'speed_up_fine',    keyboard: 'Shift+ArrowUp' },
  { action: 'speed_down_fine',  keyboard: 'Shift+ArrowDown' },

  // --- Navigation ---
  { action: 'next_document',    keyboard: 'Ctrl+ArrowRight' },
  { action: 'previous_document', keyboard: 'Ctrl+ArrowLeft' },
  { action: 'go_to_page',       keyboard: 'Ctrl+G' },
  { action: 'go_to_chapter',    keyboard: 'Ctrl+Shift+G' },
  { action: 'add_bookmark',     keyboard: 'Ctrl+B',        gesture: 'long-press' },

  // --- View ---
  { action: 'toggle_view',      keyboard: 'Ctrl+Shift+V' },
  { action: 'toggle_focused_mode', keyboard: 'Ctrl+F',     gesture: 'pinch' },

  // --- Nav Unit ---
  { action: 'cycle_nav_unit',       keyboard: 'Tab' },
  { action: 'set_nav_unit_sentence', keyboard: '1' },
  { action: 'set_nav_unit_paragraph', keyboard: '2' },
  { action: 'set_nav_unit_page',     keyboard: '3' },
  { action: 'set_nav_unit_chapter',  keyboard: '4' },
];
```

**Media Session API integration:**

```typescript
// Register with the browser's Media Session API so hardware media keys
// (Bluetooth headphones, keyboard media keys) control Voxium Reader.
if ('mediaSession' in navigator) {
  navigator.mediaSession.metadata = new MediaMetadata({
    title: document.title,
    artist: document.author,
    album: 'Voxium Reader',
  });

  navigator.mediaSession.setActionHandler('play', () => playbackController.resume());
  navigator.mediaSession.setActionHandler('pause', () => playbackController.pause());
  navigator.mediaSession.setActionHandler('previoustrack', () => navigationController.rewind());
  navigator.mediaSession.setActionHandler('nexttrack', () => navigationController.forward());
  navigator.mediaSession.setActionHandler('seekbackward', (details) => {
    const seconds = details.seekOffset ?? 15;
    navigationController.seekByTime(-seconds);
  });
  navigator.mediaSession.setActionHandler('seekforward', (details) => {
    const seconds = details.seekOffset ?? 15;
    navigationController.seekByTime(seconds);
  });

  // Update position state so lock-screen / OS media widget shows progress
  stateMachine.subscribe((position, changed) => {
    if (changed.has('paragraph')) {
      navigator.mediaSession.setPositionState({
        duration: estimatedTotalDuration,
        playbackRate: currentSpeedFactor,
        position: currentPositionSeconds,
      });
    }
  });
}
```

**All mappings are user-customizable** and stored in Supabase. The settings panel includes a key-binding editor.

### 10j. Outline / Chapter Navigation Sidebar

The sidebar (toggled via button or `Ctrl+O`) shows the document's hierarchical structure:

```
┌─────────────────────────────────┐
│ 📖 Document Outline             │
│                                 │
│ ▼ Chapter 1: Introduction       │  ← tap to jump
│   ▼ 1.1 Background              │
│     1.2 Motivation               │
│     1.3 Overview                 │
│ ▶ Chapter 2: Literature Review   │  ← collapsed
│ ▼ Chapter 3: Methods        ◀── │  ← current position indicator
│   ▼ 3.1 Data Collection         │
│     3.2 Analysis ◀──            │  ← current section
│     3.3 Validation               │
│ ▶ Chapter 4: Results             │
│ ▶ Chapter 5: Discussion          │
│                                 │
│ ─── Bookmarks ───               │
│ 📌 "...the fundamental q..." p.14│
│ 📌 "...contradicts earlier" p.31 │
│                                 │
│ ─── Highlights ───              │
│ 🟡 "methodology was..." p.22    │
│ 🔵 "key finding that..." p.45   │
└─────────────────────────────────┘
```

Tapping any heading, bookmark, or highlight triggers `playbackController.seekToNode()`. The current position is indicated with a marker that updates via the state machine's section-level events.

---

---

## 11. Platform Architecture and Long-Term Vision

Voxium Reader is designed not as a standalone web app but as a **cross-platform reading engine** with three strategic horizons:

1. **Voxium Reader** — the core reading engine (web app, browser extension, desktop, mobile)
2. **Voxium Engine** — a deployable screen reading engine that other applications can embed
3. **OpenClaw Accessibility** — making the OpenClaw autonomous AI agent fully accessible via Voxium Engine as the audio output/interaction layer

All three horizons share the same core engine (§1-10). This section defines the platform architecture that supports all of them.

### 11a. Backend: Supabase (PostgreSQL) — Not Firebase

The original spec assumed Firebase (Firestore + Auth + GCS). After evaluating the three long-term goals, **Supabase is the correct choice.** Here's why:

**Why Supabase over Firebase for Voxium:**

| Concern | Firebase | Supabase | Verdict |
|---|---|---|---|
| **Data model** | NoSQL (Firestore) — flat documents, no joins | PostgreSQL — relational, joins, foreign keys | A reference management system is *inherently relational*: papers cite papers, authors belong to institutions, tags form hierarchies, collections contain items. Modeling citation graphs in Firestore requires painful denormalization. Postgres handles this natively. **Supabase wins.** |
| **Complex queries** | Very limited WHERE clauses, no aggregations, no full-text search without Algolia | Full SQL: JOINs, CTEs, window functions, `tsvector` full-text search, `pg_trgm` fuzzy matching | Reference management requires queries like "find all papers by author X cited by papers in collection Y published after 2020." Firestore simply can't do this. **Supabase wins.** |
| **Vector search** | No native support; requires external service (Pinecone, etc.) | pgvector built in — store embeddings alongside relational data, hybrid SQL+vector queries | Semantic search over document content ("find papers similar to this abstract"), smart recommendations, and RAG over your library all require vector search. Supabase gives you this in the same database. **Supabase wins.** |
| **Pricing model** | Pay per read/write/delete — unpredictable at scale, punishes inefficient queries | Pay per storage size + compute — predictable, doesn't penalize frequent reads | A screen reader at 900 WPM with auto-save every paragraph generates a lot of writes. Firebase's per-operation pricing becomes a risk. Supabase's predictable tiers are safer. **Supabase wins.** |
| **Vendor lock-in** | Proprietary — data locked in Google ecosystem, custom query language | Open source PostgreSQL — can self-host, migrate to any Postgres provider, export everything via SQL dump | For an accessibility tool that may need institutional deployments (universities, libraries, government agencies), the ability to self-host is critical. Some institutions *cannot* use Google Cloud for compliance reasons. **Supabase wins.** |
| **Row-Level Security** | Firebase Security Rules — a custom DSL, debugged via trial-and-error | PostgreSQL RLS — SQL-based policies, testable, same language as queries | Complex access control for shared libraries, team annotations, classroom reading groups. SQL-based RLS is more expressive and testable. **Supabase wins.** |
| **Real-time** | Firebase excels here — millisecond sync, offline-first, battle-tested | Supabase Realtime via Postgres LISTEN/NOTIFY + WebSockets — good but not as mature | For reading position sync across devices, Supabase Realtime is sufficient. We're not building a chat app. **Firebase has a slight edge, but not enough to change the decision.** |
| **Auth** | Mature, good mobile support, device-based auth | GoTrue-based, OAuth providers, MFA, improving rapidly | Both adequate. Supabase Auth integrates with RLS policies which is cleaner. **Tie.** |
| **MCP availability** | firebase-mcp exists | supabase-mcp exists (community) | Both available. **Tie.** |

**Decision: Migrate to Supabase.** The relational model, pgvector, full SQL, self-hosting capability, and predictable pricing are all critical for the long-term platform — the document library, annotation system, cross-platform sync, and eventual reference management and OpenClaw integration all benefit from a relational foundation. Firebase's only advantage (real-time maturity) is not a deciding factor for this use case.

**Impact on existing spec:** All references to "Firestore" become "Supabase (Postgres)". All references to "Firebase Auth" become "Supabase Auth". GCS for file storage is replaced by **Supabase Storage** (S3-compatible, integrated with RLS). "firebase-mcp" is replaced by "supabase-mcp". Firebase Hosting is replaced by any static host (Vercel, Netlify, Cloudflare Pages, or Supabase's own hosting). Cloud Run for optional API layer is replaced by **Supabase Edge Functions** (Deno/TypeScript, runs at edge locations, direct database access).

**Updated MCP Servers:**

| Server | Purpose |
|---|---|
| **supabase-mcp** | Postgres for all structured data (users, documents, annotations, citations, collections, reading positions, voice mappings, style packages). Supabase Auth for identity. Supabase Storage for document files and audio cache. Supabase Realtime for cross-device sync. |
| **github-mcp** | Version control, dependency management |
| **replicate-mcp** | Alternative TTS models, vision models |
| **anthropic-mcp** (Claude API) | Text segmentation, emotional analysis, image/chart description, OCR post-correction, reference extraction |

### 11b. Database Schema (Core Tables)

```sql
-- ═══════════════════════════════════════════════════════════════
-- USERS AND AUTH
-- ═══════════════════════════════════════════════════════════════
-- Supabase Auth handles the auth.users table.
-- We extend it with a profile:

CREATE TABLE user_profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT,
  preferences JSONB DEFAULT '{}',            -- UI preferences, theme, etc.
  default_style_package_id UUID,
  default_speed NUMERIC DEFAULT 1.0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════
-- DOCUMENT LIBRARY (Foundation for Open Claw)
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  authors TEXT[],                             -- Array of author names
  year INTEGER,
  doi TEXT,
  isbn TEXT,
  source_url TEXT,                            -- Where the document was imported from
  source_type TEXT,                           -- 'upload', 'browser_extension', 'url', 'doi_lookup'
  file_path TEXT,                             -- Path in Supabase Storage
  file_hash TEXT,                             -- SHA-256 for dedup and cache lookup
  format TEXT,                                -- 'pdf', 'epub', 'docx', 'html', 'txt', etc.
  page_count INTEGER,
  word_count INTEGER,
  language TEXT DEFAULT 'en',
  ast_snapshot JSONB,                         -- Serialized AST (compressed)
  metadata JSONB DEFAULT '{}',                -- Flexible metadata (publisher, journal, etc.)
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Full-text search on document metadata
ALTER TABLE documents ADD COLUMN fts tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english',
      coalesce(title, '') || ' ' ||
      coalesce(array_to_string(authors, ' '), '') || ' ' ||
      coalesce(metadata->>'abstract', '')
    )
  ) STORED;
CREATE INDEX documents_fts_idx ON documents USING gin(fts);

-- ═══════════════════════════════════════════════════════════════
-- REFERENCE MANAGEMENT (Open Claw foundation)
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE collections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  parent_id UUID REFERENCES collections(id),  -- Nested collections
  color TEXT,
  icon TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE collection_documents (
  collection_id UUID REFERENCES collections(id) ON DELETE CASCADE,
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  added_at TIMESTAMPTZ DEFAULT NOW(),
  sort_order INTEGER DEFAULT 0,
  PRIMARY KEY (collection_id, document_id)
);

CREATE TABLE tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT,
  UNIQUE(user_id, name)
);

CREATE TABLE document_tags (
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  tag_id UUID REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (document_id, tag_id)
);

-- Citation graph: which documents cite which
CREATE TABLE citations (
  citing_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  cited_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  context TEXT,                               -- The sentence containing the citation
  page_number INTEGER,
  confidence NUMERIC DEFAULT 1.0,            -- AI extraction confidence
  PRIMARY KEY (citing_id, cited_id)
);

-- ═══════════════════════════════════════════════════════════════
-- ANNOTATIONS AND READING STATE
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE annotations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,                         -- 'highlight', 'comment', 'bookmark', 'sticky_note'
  ast_node_id TEXT,
  plain_text_offset INTEGER,
  plain_text_end INTEGER,
  content TEXT,                               -- Comment text, note text
  color TEXT,
  page_number INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE reading_positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  ast_node_id TEXT NOT NULL,
  block_id TEXT,
  sample_offset INTEGER,
  speed_factor NUMERIC,
  progress_percent NUMERIC,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(document_id, user_id)
);

-- ═══════════════════════════════════════════════════════════════
-- VOICE AND STYLE CONFIGURATION
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE style_packages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id),    -- NULL for built-in packages
  name TEXT NOT NULL,
  description TEXT,
  config JSONB NOT NULL,                      -- Full StylePackage serialized
  is_builtin BOOLEAN DEFAULT FALSE,
  is_public BOOLEAN DEFAULT FALSE,           -- Shared packages other users can import
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE pronunciation_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  language TEXT NOT NULL,
  search_text TEXT NOT NULL,
  match_mode TEXT NOT NULL,                   -- 'word', 'anywhere', 'regex'
  ignore_case BOOLEAN DEFAULT TRUE,
  action TEXT NOT NULL,                       -- 'pronounce_as', 'skip'
  replacement TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════
-- VECTOR EMBEDDINGS (for semantic search and recommendations)
-- ═══════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE document_embeddings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index INTEGER,                        -- Which chunk of the document
  chunk_text TEXT,                             -- The text that was embedded
  embedding vector(384),                      -- gte-small produces 384 dimensions
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX document_embeddings_idx ON document_embeddings
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- Semantic search function
CREATE OR REPLACE FUNCTION match_documents(
  query_embedding vector(384),
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 10,
  p_user_id UUID DEFAULT NULL
)
RETURNS TABLE (
  document_id UUID,
  chunk_text TEXT,
  similarity FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    de.document_id,
    de.chunk_text,
    1 - (de.embedding <=> query_embedding) AS similarity
  FROM document_embeddings de
  JOIN documents d ON d.id = de.document_id
  WHERE (p_user_id IS NULL OR d.user_id = p_user_id)
    AND 1 - (de.embedding <=> query_embedding) > match_threshold
  ORDER BY de.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- ═══════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE annotations ENABLE ROW LEVEL SECURITY;
ALTER TABLE reading_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE style_packages ENABLE ROW LEVEL SECURITY;

-- Users can only see their own documents (extend for sharing later)
CREATE POLICY documents_user_policy ON documents
  FOR ALL USING (user_id = auth.uid());

CREATE POLICY annotations_user_policy ON annotations
  FOR ALL USING (user_id = auth.uid());

CREATE POLICY reading_positions_user_policy ON reading_positions
  FOR ALL USING (user_id = auth.uid());

-- Style packages: see your own + all built-in + all public
CREATE POLICY style_packages_policy ON style_packages
  FOR SELECT USING (
    user_id = auth.uid() OR is_builtin = TRUE OR is_public = TRUE
  );
CREATE POLICY style_packages_write_policy ON style_packages
  FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY style_packages_update_policy ON style_packages
  FOR UPDATE USING (user_id = auth.uid());
```

### 11c. Cross-Platform Architecture

Voxium Reader ships on four surfaces. The core engine is shared; the platform layer adapts it to each environment.

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Voxium Core Engine                           │
│                                                                     │
│  AST · Speech Pipeline · Awareness Layer · PlaybackController       │
│  Expressive Synthesis · Navigation · Highlighting · Annotation      │
│                                                                     │
│  100% TypeScript · Runs in any JS environment with Web Audio API    │
└───────────────┬─────────────┬──────────────┬───────────────┬────────┘
                │             │              │               │
         ┌──────┴──────┐ ┌───┴────┐  ┌──────┴──────┐  ┌────┴────────┐
         │  Web App    │ │Browser │  │  Desktop    │  │  Mobile     │
         │             │ │Ext.   │  │  (Tauri)    │  │  (Capacitor │
         │  React SPA  │ │Chrome │  │             │  │   or React  │
         │  Vite build │ │Firefox│  │  Native     │  │   Native)   │
         │             │ │Safari │  │  file access │  │             │
         │  Full UI    │ │Edge   │  │  System TTS  │  │  Background │
         │             │ │       │  │  fallback    │  │  audio      │
         │             │ │Inject │  │  Tray icon   │  │  Lock-screen│
         │             │ │into   │  │  Global      │  │  controls   │
         │             │ │any    │  │  hotkeys     │  │             │
         │             │ │page   │  │             │  │             │
         └──────┬──────┘ └───┬────┘  └──────┬──────┘  └────┬────────┘
                │            │              │               │
                └────────────┴──────┬───────┴───────────────┘
                                    │
                            ┌───────┴────────┐
                            │   Supabase     │
                            │                │
                            │  Postgres      │
                            │  Auth          │
                            │  Storage       │
                            │  Realtime      │
                            │  Edge Functions│
                            │  pgvector      │
                            └────────────────┘
```

#### Browser Extension (Speechify-Style)

The browser extension is the primary acquisition channel — users encounter Voxium while browsing, not by uploading documents. It injects into any web page and offers to read the content aloud with full Voxium capabilities.

**Architecture:**

```
┌─────────────────────────────────────────────────────────┐
│                    Browser Extension                     │
│                                                         │
│  ┌─────────────────┐   ┌────────────────────────────┐  │
│  │ Content Script   │   │ Extension Service Worker    │  │
│  │                  │   │ (Background)                │  │
│  │ Injected into    │   │                            │  │
│  │ every page.      │   │ Manages auth state,        │  │
│  │                  │   │ Supabase connection,        │  │
│  │ Detects readable │   │ offline audio cache,        │  │
│  │ content.         │   │ TTS worker pool.            │  │
│  │                  │   │                            │  │
│  │ Extracts DOM →   │   │ Runs HeadTTS + libsonic    │  │
│  │ builds AST.      │   │ in offscreen document      │  │
│  │                  │   │ (Chrome) or background      │  │
│  │ Injects floating │   │ audio context.              │  │
│  │ player + highlight│  │                            │  │
│  │ overlay.         │   │ Syncs reading position,     │  │
│  │                  │   │ annotations, and saved      │  │
│  │ Handles click-to-│   │ articles to Supabase.       │  │
│  │ word, selection. │   │                            │  │
│  └────────┬─────────┘   └───────────┬────────────────┘  │
│           │                         │                    │
│           │◄───── messages ────────►│                    │
│           │                         │                    │
│  ┌────────┴─────────────────────────┴────────────────┐  │
│  │                  Popup / Side Panel                │  │
│  │                                                    │  │
│  │  Library view: saved articles, reading queue       │  │
│  │  Speed / voice / style controls                    │  │
│  │  Account settings                                  │  │
│  │  Quick-save current page to library                │  │
│  └────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

**Content Script responsibilities:**

```typescript
// content-script.ts — Injected into every web page

class VoxiumContentScript {
  // 1. DOM → AST extraction
  //    Parse the page's readable content (article body, main content area)
  //    using Readability.js (Mozilla's algorithm) or custom heuristics.
  //    Build the same Unified AST used by the full web app.
  async extractContent(): Promise<DocumentAST> {
    const article = new Readability(document.cloneNode(true)).parse();
    return buildASTFromHTML(article.content, {
      preserveBoundingBoxes: true,  // Map AST nodes back to live DOM elements
      preserveFormatting: true,
    });
  }

  // 2. Floating player injection
  //    Inject a minimal transport bar at the bottom of the page.
  //    Shadow DOM to avoid style conflicts with the host page.
  injectPlayer(): void {
    const shadow = document.createElement('div');
    shadow.attachShadow({ mode: 'closed' });
    // Render TransportBar component inside shadow DOM
  }

  // 3. Highlight overlay
  //    Overlay synchronized highlights on the live DOM elements.
  //    Uses the AST's bounding box data mapped to actual DOM rects.
  injectHighlightOverlay(): void {
    // SVG overlay positioned absolutely over the page content
    // Updated by state machine boundary events from the service worker
  }

  // 4. User interactions
  //    - Click/double-tap on any word → start reading from there
  //    - Text selection → "Read aloud" context menu option
  //    - Hover-to-listen mode (optional, like Speechify)
  //    - Right-click context menu integration
  setupInteractions(): void {
    document.addEventListener('dblclick', (e) => {
      const word = this.resolveClickToASTNode(e);
      if (word) this.requestPlayFromPosition(word.id);
    });
  }

  // 5. "Save to Library" — save the current page as a document
  //    Captures the article content, metadata (title, author, URL),
  //    and stores it in Supabase for offline reading in the full app.
  async saveToLibrary(): Promise<void> {
    const ast = await this.extractContent();
    const metadata = this.extractMetadata(); // title, author, date, URL
    await chrome.runtime.sendMessage({
      type: 'SAVE_TO_LIBRARY',
      payload: { ast, metadata },
    });
  }
}
```

**Service Worker responsibilities:**

```typescript
// service-worker.ts — Extension background script

class VoxiumServiceWorker {
  private supabase: SupabaseClient;
  private ttsPool: TTSWorkerPool;        // Web Workers for HeadTTS
  private audioCache: IndexedDBCache;     // Local audio cache

  // Handle messages from content scripts
  async onMessage(msg: ExtensionMessage, sender: chrome.runtime.MessageSender) {
    switch (msg.type) {
      case 'PLAY_FROM_POSITION':
        // Synthesize + stretch audio blocks, send back to content script
        // Content script plays via injected Audio element or Web Audio
        break;

      case 'SAVE_TO_LIBRARY':
        // Store document in Supabase with full metadata
        // Generate embeddings for semantic search
        // Extract citations if it's an academic paper
        break;

      case 'SYNC_READING_POSITION':
        // Persist to Supabase reading_positions table
        break;

      case 'GET_STYLE_PACKAGE':
        // Fetch user's active style package from Supabase
        break;
    }
  }
}
```

**Browser support:**
- Chrome (Manifest V3) — primary target
- Firefox (WebExtension API)
- Safari (Safari Web Extension)
- Edge (Chromium-based, same as Chrome)

#### Desktop App (Tauri)

Tauri wraps the web app in a native window with access to the local filesystem, system TTS as a fallback, global keyboard shortcuts (read selected text from any app), and a system tray icon for quick access.

**Added capabilities over web app:**
- Direct file system access (no upload needed)
- System-wide global hotkey: select text in any app → press shortcut → Voxium reads it
- System tray with quick controls
- Native file associations (.pdf, .epub, .docx open in Voxium)
- Larger local cache for offline operation
- Optional system TTS fallback when WebGPU isn't available

#### Mobile App (Capacitor or React Native)

**Added capabilities over web app:**
- Background audio playback (screen off)
- Lock screen / notification controls via Media Session API
- Share sheet integration (share any content from any app to Voxium)
- Camera-based OCR (scan a physical page)
- Offline download of documents and pre-synthesized audio
- Haptic feedback on chapter boundaries

### 11d. Voxium Engine: Deployable Screen Reading SDK

The core engine (§1-10) is designed to be extractable as an independent library that other applications can embed. This is the foundation for Open Claw and potentially third-party integrations.

```typescript
// @voxium/engine — the NPM package

import { VoxiumEngine, StylePackage } from '@voxium/engine';

// Initialize the engine with a document
const engine = new VoxiumEngine({
  supabaseUrl: '...',           // Optional — engine works without backend
  supabaseKey: '...',           // For persistence, sync, etc.
  ttsBackend: 'headtts',       // or 'system' or 'replicate'
  stylePackage: StylePackage.CLEAR_READER,
});

// Load a document
await engine.loadDocument(htmlContent, { format: 'html' });
// or: await engine.loadFile(fileBlob, { format: 'pdf' });
// or: await engine.loadURL('https://example.com/article');

// Attach to a DOM container for highlight rendering
engine.attachToContainer(document.getElementById('reader'));

// Play
engine.play();
engine.setSpeed(3.5);
engine.seekToWord(astNodeId);
engine.pause();

// Listen to events
engine.on('word', (position) => { /* ... */ });
engine.on('sentence', (position) => { /* ... */ });
engine.on('progress', (percent) => { /* ... */ });

// Access the AST for external use (e.g., citation extraction)
const ast = engine.getAST();
```

The engine is a pure TypeScript library with no React dependency. The web app, browser extension, desktop app, and mobile app are all thin shells around it. Open Claw embeds it for its reading pane.

### 11e. OpenClaw Accessibility: Voxium as an Accessible Agent Interface

[OpenClaw](https://openclaw.ai) is the viral open-source autonomous AI agent (100k+ GitHub stars, formerly Clawdbot/Moltbot) that acts as a personal AI assistant — managing emails, browsing the web, controlling smart home devices, scheduling, and executing multi-step tasks autonomously via messaging platforms like WhatsApp, Telegram, Discord, and Slack.

**The accessibility problem:** OpenClaw's interface is primarily text-based messaging. For sighted users this works naturally — you read the agent's responses on screen. But for users who are blind or have low vision, interacting with a persistent, proactive AI agent that sends long-form responses, structured data, and document attachments requires a reading engine that can handle all of that content expressively and efficiently.

**The solution:** Voxium Engine becomes OpenClaw's accessible output layer. Instead of (or alongside) reading OpenClaw's responses on a screen, the user hears them through Voxium — with all the expressive synthesis, auditory formatting, and navigation capabilities specified in this document.

```
┌─────────────────────────────────────────────────────────────────────┐
│                    OpenClaw + Voxium Integration                     │
│                                                                     │
│  ┌──────────────────────┐       ┌──────────────────────────────┐   │
│  │     OpenClaw Agent    │       │       Voxium Engine           │   │
│  │                       │       │                               │   │
│  │  Gateway (Node.js)    │──────►│  Receives agent output as     │   │
│  │  Skills, memory,      │ text, │  structured content.          │   │
│  │  tool execution,      │ HTML, │                               │   │
│  │  LLM reasoning        │ files │  Builds AST, applies          │   │
│  │                       │       │  expressive synthesis,        │   │
│  │  Proactive messages   │──────►│  reads aloud with full        │   │
│  │  (reminders, alerts,  │       │  auditory formatting.         │   │
│  │   task completions)   │       │                               │   │
│  │                       │◄──────│  User voice input routed      │   │
│  │  Receives user        │ voice │  back to OpenClaw as text     │   │
│  │  commands             │ input │  (via Whisper transcription).  │   │
│  └──────────────────────┘       └──────────────────────────────┘   │
│                                                                     │
│  Key capabilities:                                                  │
│                                                                     │
│  • Agent responses read with expressive synthesis                   │
│    (code blocks get code style, lists get list pauses,              │
│     emphasis gets auditory formatting, etc.)                        │
│                                                                     │
│  • Document attachments (PDFs, emails, web pages the agent          │
│    fetches) opened directly in Voxium Reader with full              │
│    highlighting and annotation support                              │
│                                                                     │
│  • Structured data (tables, JSON, task lists) read with             │
│    appropriate auditory structure and navigation                    │
│                                                                     │
│  • Proactive messages from OpenClaw (reminders, completed tasks,    │
│    alerts) spoken as interrupts or queued for next pause            │
│                                                                     │
│  • Voice-first interaction: user speaks commands, Voxium            │
│    transcribes and sends to OpenClaw, reads response back           │
│                                                                     │
│  • Navigation through conversation history using the same           │
│    nav-unit system (rewind by message, by task, by topic)           │
│                                                                     │
│  • Audio annotations on agent responses ("remember this part")      │
│    that persist in Voxium's annotation system                       │
└─────────────────────────────────────────────────────────────────────┘
```

**Integration architecture:**

```typescript
// OpenClaw skill that routes output through Voxium Engine

// openclaw-voxium-skill/index.ts
import { VoxiumEngine, StylePackage } from '@voxium/engine';

export default {
  name: 'voxium-reader',
  description: 'Accessible screen reading of all agent output via Voxium Engine',

  // Called whenever OpenClaw produces output for the user
  async onAgentResponse(response: AgentResponse, context: SkillContext) {
    const engine = context.getService('voxium');

    if (response.type === 'text' || response.type === 'markdown') {
      // Parse the response as a document, build AST, read aloud
      await engine.loadDocument(response.content, {
        format: response.type === 'markdown' ? 'markdown' : 'text',
        stylePackage: context.userPreferences.stylePackage,
      });
      await engine.play();
    }

    if (response.type === 'file') {
      // Agent fetched a document — open it in full Voxium Reader
      await engine.loadFile(response.fileBlob, {
        format: response.mimeType,
      });
      // User can now navigate, annotate, and interact with the document
    }

    if (response.type === 'structured_data') {
      // Tables, JSON, task lists — convert to accessible narration
      const narration = await engine.narrateStructuredData(response.data);
      await engine.play();
    }
  },

  // Called when the user speaks (voice input via Voxium)
  async onVoiceInput(transcript: string, context: SkillContext) {
    // Route the transcribed voice command back to OpenClaw
    await context.sendToAgent(transcript);
  },

  // Called when OpenClaw proactively sends a message
  async onProactiveMessage(message: ProactiveMessage, context: SkillContext) {
    const engine = context.getService('voxium');
    const playbackState = engine.getPlaybackState();

    if (message.priority === 'urgent') {
      // Interrupt current reading with an earcon + the message
      await engine.interrupt(message.content);
    } else {
      // Queue for next natural pause (paragraph boundary, etc.)
      engine.queueForNextPause(message.content);
    }
  },
};
```

**Custom navigation units for agent conversations:**

```typescript
// Extend NavigationUnit for OpenClaw conversation history
type OpenClawNavigationUnit =
  | NavigationUnit              // All standard units from §10a
  | 'agent_message'             // Jump to next/previous agent response
  | 'user_command'              // Jump to next/previous user command
  | 'task_boundary'             // Jump between distinct tasks/topics
  | 'code_block'                // Jump between code blocks in responses
  | 'list_item';                // Navigate through list items in responses
```

This integration means a blind user can run OpenClaw as their personal AI assistant with the same rich, expressive audio experience that Voxium provides for documents — not just flat TTS of text messages, but structured, formatted, navigable audio with full controls.

### 11f. Accessible Reference Management (Future Vision)

Separately from OpenClaw, the document library and database schema (§11b) are designed to grow into a full accessible reference management system — a Voxium-native alternative to Zotero/Papers for researchers who need accessibility.

This is a longer-term goal that builds on:
- The document library tables (documents, collections, tags) already in §11b
- The citation graph tables (citations, authors, document_authors) already in §11b
- pgvector semantic search over document embeddings
- The annotation system (§7) for research note-taking
- The browser extension (§11c) for capturing web references
- AI-powered metadata extraction and citation resolution via Claude API

Key future capabilities: DOI/CrossRef/ORCID lookup, BibTeX/RIS/Zotero import/export, citation graph browsing (navigate from paper to cited paper, hear the citing context read aloud), bibliography generation with CSL formatting, shared team libraries, and semantic search across an entire research library ("find papers similar to this paragraph").


---

### Frontend (Shared Core)
- **Engine:** `@voxium/engine` — pure TypeScript, no framework dependency
- **Web App:** React + TypeScript (Vite build)
- **Rendering:** Canvas (PDF pages) + DOM (EPUB/HTML) + SVG (highlight overlays)
- **Audio:** Web Audio API for playback, AudioWorklet for boundary detection and libsonic
- **State:** Zustand for global state, React Query / TanStack Query for server state
- **Styling:** Tailwind CSS

### Speech Processing (Client-Side)
- **HeadTTS:** `@met4citizen/headtts` (Kokoro-82M ONNX, WebGPU/WASM)
- **Libsonic:** Custom WASM build from `waywardgeek/sonic` via Emscripten
- **Forced Alignment (fallback):** `whisper-web` or Replicate Whisper API

### Document Parsing
- **PDF:** pdf.js + Replicate/Claude vision for layout
- **EPUB:** `epubjs` or custom XHTML parser
- **DOCX:** `mammoth.js`
- **RTF:** `rtf-parser`
- **HTML (browser extension):** Readability.js for article extraction
- **OCR:** Tesseract.js (client-side WASM, primary), Claude API for post-OCR correction and reading order detection

### Backend / Infrastructure
- **Supabase Auth** for user accounts (OAuth, email/password, MFA)
- **Supabase Postgres** for all structured data (documents, annotations, citations, collections, reading positions, voice mappings, style packages)
- **pgvector** for semantic search over document embeddings
- **Supabase Storage** (S3-compatible) for document files, audio block cache, exported files
- **Supabase Realtime** for cross-device reading position sync
- **Supabase Edge Functions** (Deno/TypeScript) for server-side processing
- **Replicate** for alt-voice TTS, vision models, Whisper alignment
- **Claude API** for text segmentation, emotional analysis, image description, citation extraction, document summarization

### Cross-Platform
- **Browser Extension:** Chrome (MV3), Firefox, Safari, Edge — content script + service worker
- **Desktop:** Tauri (Rust + WebView) — native file access, global hotkeys, system tray
- **Mobile:** Capacitor or React Native — background audio, share sheet, camera OCR

### Build / Deploy
- **Bundler:** Vite (web app), custom build scripts (extension, Tauri, Capacitor)
- **Deployment:** Vercel or Cloudflare Pages (web app), Chrome Web Store / AMO / App Store (extension), GitHub Releases (desktop), App Store / Google Play (mobile)
- **CI/CD:** GitHub Actions via github-mcp

---

## Existing Repositories and Dependencies

Before beginning implementation, the agent should familiarize itself with the following repositories. These are the primary upstream dependencies and should be used as-is or forked — not reimplemented from scratch.

### Core TTS and Audio Processing

| Repository | Stars | License | Purpose in Voxium | Notes |
|---|---|---|---|---|
| [`met4citizen/HeadTTS`](https://github.com/met4citizen/HeadTTS) | ~200 | MIT | **Primary TTS engine.** Kokoro-82M ONNX inference in-browser via WebGPU/WASM. Provides phoneme-level timestamps critical for our word-boundary awareness layer. | NPM: `@met4citizen/headtts`. Uses `@huggingface/transformers` + `onnx-community/Kokoro-82M-v1.0-ONNX-timestamped`. Supports ~20 English voices. Phoneme timestamps are what make our simulated timing → boundary events pipeline work. |
| [`waywardgeek/sonic`](https://github.com/waywardgeek/sonic) | ~620 | Apache 2.0 | **Speech time-stretching.** Optimized for >2× speedup (up to 6×) with minimal distortion. PICOLA-based for <2×, custom algorithm above. | Plain ANSI C. Must be compiled to WASM via Emscripten. See [`echogarden-project/sonic-wasm`](https://github.com/echogarden-project/sonic-wasm) for an existing WASM build. Also see [`this-spring/sonic-pcm-player`](https://github.com/this-spring/sonic-pcm-player) for a browser WASM integration example. Integer math, no FPU dependency. |
| [`onnx-community/Kokoro-82M-v1.0-ONNX-timestamped`](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX-timestamped) | — | Apache 2.0 | **The TTS model itself.** Timestamped variant of Kokoro-82M in ONNX format, consumed by HeadTTS. | Available on HuggingFace. Quantized variants (q4, q8, fp16) available for different speed/quality tradeoffs. |

### Document Parsing

| Repository | Stars | License | Purpose in Voxium | Notes |
|---|---|---|---|---|
| [`mozilla/pdf.js`](https://github.com/mozilla/pdf.js) | ~50k | Apache 2.0 | **PDF rendering and text extraction.** Used for the original-format view (Canvas rendering) and for extracting text layer positions for AST construction. | NPM: `pdfjs-dist`. Provides per-glyph positions, font data, page rendering. The core of our PDF import pipeline. |
| [`Hopding/pdf-lib`](https://github.com/Hopding/pdf-lib) | ~7.8k | MIT | **PDF modification.** Writing highlight annotations, text annotations, and embedded attachments (audio notes) back into PDF files for export. | No external dependencies. Works in browser and Node. Use for annotation export to PDF (§7f). Does not natively support highlight annotations — requires low-level PDF object construction. Consider [`highkite/pdfAnnotate`](https://github.com/highkite/pdfAnnotate) as alternative for annotation-specific operations. |
| [`futurepress/epub.js`](https://github.com/futurepress/epub.js) | ~6.8k | BSD | **EPUB parsing and rendering.** Handles EPUB decompression, spine navigation, TOC parsing, and rendering XHTML chapters into the original-format view. | NPM: `epubjs`. Has hook system for content manipulation (useful for injecting highlight overlays). Companion: [`futurepress/epubjs-reader`](https://github.com/futurepress/epubjs-reader). |
| [`mwilliamson/mammoth.js`](https://github.com/mwilliamson/mammoth.js) | ~5k+ | BSD-2-Clause | **DOCX → HTML conversion.** Converts .docx to clean semantic HTML using style mappings (Heading 1 → h1, etc.). | NPM: `mammoth`. Works in browser and Node. Preserves bold, italic, underline, tables, footnotes, images. Custom style maps let us preserve formatting attributes needed for auditory formatting (§5b). |
| [`harshankur/officeParser`](https://github.com/harshankur/officeParser) | ~small | — | **Multi-format office parsing with AST output.** Parses docx, pptx, xlsx, odt, pdf, rtf and produces hierarchical AST with metadata and text formatting. | Potential alternative/complement to mammoth.js — especially valuable because it already produces an AST structure. Evaluate whether its AST can map directly to Voxium's Unified AST. |
| [`mozilla/readability`](https://github.com/mozilla/readability) | ~9k+ | Apache 2.0 | **Web page article extraction.** The same algorithm that powers Firefox Reader View. Used by the browser extension content script to extract readable content from any web page. | NPM: `@mozilla/readability`. Returns title, byline, content (HTML), textContent, excerpt, lang. Use `isProbablyReaderable()` to decide whether to offer the Voxium player on a page. |

### OCR

| Repository | Stars | License | Purpose in Voxium | Notes |
|---|---|---|---|---|
| [`naptha/tesseract.js`](https://github.com/naptha/tesseract.js) | ~35k | Apache 2.0 | **Primary OCR engine.** Browser-side WASM build of Tesseract. 100+ languages. v6 has improved memory management and performance. | NPM: `tesseract.js`. Runs in Web Worker to avoid blocking UI. For word/symbol-level bounding boxes, enable `blocks` output. See [`Balearica/tesseract.js-electron`](https://github.com/Balearica/tesseract.js-electron) for desktop integration patterns. Also see [`Scribe.js`](https://github.com/scribeocr/scribe.js) for enhanced recognition model. |
| [`robertknight/tesseract-wasm`](https://github.com/robertknight/tesseract-wasm) | ~500+ | Apache 2.0 | **Lightweight alternative WASM build.** Smaller download (~2.1MB vs tesseract.js's larger bundle). WASM SIMD support for 1.6× performance gain. | Evaluate for use if bundle size is critical (e.g., browser extension). Has orientation detection. More minimal API than tesseract.js. |

### Supabase and Database

| Repository | Stars | License | Purpose in Voxium | Notes |
|---|---|---|---|---|
| [`supabase/supabase`](https://github.com/supabase/supabase) | ~75k+ | Apache 2.0 | **Backend platform.** PostgreSQL, Auth, Storage, Realtime, Edge Functions. | Use `@supabase/supabase-js` client library. Realtime via `LISTEN/NOTIFY` + WebSockets for cross-device sync of reading position, annotations. |
| [`pgvector/pgvector`](https://github.com/pgvector/pgvector) | ~15k+ | PostgreSQL | **Vector similarity search.** Stores document embeddings for semantic search. | Enabled as Postgres extension in Supabase. Use `vector(384)` columns with `gte-small` embeddings. Cosine distance operator: `<=>`. |
| [`supabase/vecs`](https://github.com/supabase/vecs) | ~small | — | **Python vector client for pgvector.** Useful for batch embedding generation jobs. | Use if building a server-side embedding pipeline. For client-side, use `supabase-js` with `rpc()` calls to match functions. |

### Other Key Dependencies

| Repository | Stars | License | Purpose in Voxium | Notes |
|---|---|---|---|---|
| [`openai/whisper`](https://github.com/openai/whisper) (via Replicate) | ~75k+ | MIT | **Audio transcription.** Used for forced alignment fallback (non-Kokoro voices) and audio annotation transcription for text export. | Use via Replicate API or [`xenova/whisper-web`](https://github.com/niconiahi/whisper-web) for browser-side inference. |
| [`niconiahi/whisper-web`](https://github.com/niconiahi/whisper-web) | — | — | **Browser-side Whisper.** ONNX-based Whisper for client-side audio transcription without server roundtrip. | Evaluate for audio annotation transcription and for voice input in the OpenClaw integration. |
| [`agentcooper/react-pdf-highlighter`](https://github.com/agentcooper/react-pdf-highlighter) | ~2.5k | MIT | **React PDF annotation components.** Set of React components for PDF highlight/annotation overlays on top of pdf.js. | Study for patterns on how to overlay annotations on pdf.js-rendered pages. May be directly usable for the original-format view annotation layer. |

---

## Implementation Phases

> **Note to agent:** Each phase lists the upstream repos and NPM packages you should install and reference. Do not reimplement functionality that already exists in these libraries. Fork only when the upstream API is insufficient.

### Phase 1 — Core Reading Loop
**Key repos:** `@met4citizen/headtts`, `waywardgeek/sonic` (→ WASM via `echogarden-project/sonic-wasm` or custom Emscripten build), `epubjs`

- [ ] Document importer for plain text and EPUB
- [ ] Unified AST with plainTextRange
- [ ] HeadTTS integration (browser, single voice)
- [ ] Libsonic WASM compilation and integration
- [ ] Timing simulation worker (ground-truth timings, not estimation)
- [ ] Block buffer manager with immediate + prefetch + simulation
- [ ] **PlaybackController — Phase A:**
  - [ ] State machine: idle → loading → playing → paused transitions
  - [ ] `playFromPosition()`: click anywhere to begin playback
  - [ ] `pause()` / `resume()`: with exact snapshot capture
- [ ] **Transport bar — Phase A:**
  - [ ] Play/Pause button
  - [ ] Speed slider (0.5x-6x) with WPM display
  - [ ] Progress scrubber with drag-to-seek
  - [ ] Rewind/Forward buttons (fixed at sentence unit initially)
- [ ] **Playback Awareness Layer — Phase A:**
  - [ ] AudioWorklet boundary emitter (word-level events from audio thread)
  - [ ] ReadingPositionStateMachine (canonical position tracking)
  - [ ] Single-layer word highlighting driven by state machine events

### Phase 2 — Multi-Layer Highlighting and Dual View
**Key repos:** `mozilla/pdf.js` (`pdfjs-dist`), `futurepress/epub.js` (`epubjs`), `agentcooper/react-pdf-highlighter` (study for SVG overlay patterns on pdf.js canvases)
- [ ] Claude-powered clause/sentence segmentation
- [ ] **PlaybackController — Phase B:**
  - [ ] `seekDuringPlayback()`: mid-playback seek with audio cutoff and highlight snap
  - [ ] Rapid-click debouncing and queuing
  - [ ] Same-block fast-path seek vs. cross-block seek
  - [ ] Click-to-seek in both plain-text and original-format views
  - [ ] Bounding box → AST node resolution for original-format clicks
- [ ] **Transport bar — Phase B:**
  - [ ] Configurable navigation units (sentence, paragraph, page, chapter, time-based)
  - [ ] Independent rewind/forward unit setting
  - [ ] Long-press on rewind/forward to show nav unit picker
  - [ ] Smart rewind (snap to sentence start when close)
  - [ ] Footer status line (page, chapter, percentage, current nav unit)
- [ ] **Playback Awareness Layer — Phase B:**
  - [ ] Extend boundary emitter to fire clause/sentence/paragraph/section events
  - [ ] PredictiveHighlightScheduler (pre-schedule + drift correction)
  - [ ] State machine subscriber system (auto-pause, progress logging, analytics)
- [ ] Multi-layer highlighting (word, clause, sentence, paragraph) driven by typed boundary events
- [ ] Original-format view renderer for PDF and EPUB
- [ ] Bounding box computation and SVG overlay system
- [ ] View toggle (plain text ↔ original format)

### Phase 3 — Expressive Synthesis and Advanced TTS
**Key repos:** `@met4citizen/headtts` (multiple voices), Replicate API (alt voices), `waywardgeek/sonic` (per-word stretch rate variation for auditory formatting)
- [ ] Multiple Kokoro voices via HeadTTS
- [ ] Replicate-hosted alternative voices (ElevenLabs, Chatterbox)
- [ ] Forced alignment for non-Kokoro voices
- [ ] **Layer A — Voice Assignment:**
  - [ ] Voice-per-attribute mapping UI and rules engine
  - [ ] Supabase persistence of voice assignments
- [ ] **Layer B — Auditory Formatting:**
  - [ ] AuditoryStyle engine: per-word prosodic modification (speed, pitch, volume, spacing)
  - [ ] Web Audio processing chain: GainNode, BiquadFilter, Compressor, Convolver
  - [ ] AudioParam automation from simulated timing array
  - [ ] Earcon system: pre-loaded audio cue library, injection at block assembly
  - [ ] Default "Clear Reader" format style package
  - [ ] Rule stacking and priority resolution
- [ ] **Layer C — Emotional Expressiveness:**
  - [ ] Claude API emotional analysis during text segmentation
  - [ ] Emotion-to-AuditoryStyle mapping with intensity scaling
  - [ ] Gradual transition interpolation between emotional segments
  - [ ] Simple/lightweight fallback analysis mode (client-side sentiment)
  - [ ] Per-emotion enable/disable and intensity overrides
- [ ] **Whitespace-to-Pause Mapping:**
  - [ ] Blank line counting during AST construction
  - [ ] Speed-scaled pause duration with minimum floors
  - [ ] Silence token injection into block audio
  - [ ] Pause triggers for all structural boundaries (paragraph, section, chapter, lists, tables, media, context shifts)
- [ ] **Style Packages:**
  - [ ] Built-in packages: Clear Reader, Academic, Dramatic, Speed Reader, Plain
  - [ ] Custom package creation, editing, and persistence in Supabase
  - [ ] Package export/import as JSON
  - [ ] Per-document package assignment
  - [ ] Quick customization UI: master sliders, individual toggles, preview
- [ ] Pronunciation dictionary (word/anywhere/regex matching, pronounce-as/skip actions)
- [ ] Per-language dictionary storage in Supabase

### Phase 4 — Annotation, Audio Notes, and Export
**Key repos:** `Hopding/pdf-lib` (write annotations to PDF), `highkite/pdfAnnotate` (PDF annotation primitives), `@supabase/supabase-js` (Storage for audio recordings, Realtime for sync), Whisper via Replicate or `whisper-web` (audio note transcription)
- [ ] **Highlighting and marking:**
  - [ ] Multi-color highlighting with user-customizable semantic labels
  - [ ] Underline and strikethrough marking
  - [ ] Highlight creation in both plain-text and original-format views
  - [ ] Bidirectional annotation sync between views
  - [ ] Contextual annotation toolbar on text selection
  - [ ] Semantic tagging system (key finding, methodology, disagree, etc.)
  - [ ] Keyboard shortcuts for quick color application (Alt+1 through Alt+6)
- [ ] **Comments and notes:**
  - [ ] Text comments attached to highlighted ranges
  - [ ] Sticky notes attached to points
  - [ ] Cross-reference links between annotations and between documents
- [ ] **Audio annotations:**
  - [ ] Microphone recording attached to document positions (Ctrl+Shift+R)
  - [ ] Auto-pause TTS during recording
  - [ ] Upload recordings to Supabase Storage
  - [ ] Audio annotation playback inline during reading (§7e)
  - [ ] Configurable: inline / skip / earcon-only modes
  - [ ] Crossfade between TTS and audio note playback
  - [ ] "Audio note" announcement before/after (configurable)
- [ ] **Bookmarks:**
  - [ ] Add at current position, list in sidebar, navigate via nav unit
  - [ ] Navigate to next/previous bookmark and highlight via nav unit
- [ ] **Annotation extraction and export:**
  - [ ] Export to Markdown, HTML, JSON, CSV
  - [ ] Export with surrounding context (configurable word count)
  - [ ] Group by position, type, color, tag, or date
  - [ ] Audio note transcription via Whisper for text export
  - [ ] Write annotations back to PDF (pdf-lib) and DOCX
  - [ ] Full-text search across all annotations (Supabase tsvector)
  - [ ] Upload annotated documents to Supabase Storage

### Phase 5 — Vision, OCR, and Accessibility
**Key repos:** `naptha/tesseract.js` (primary OCR), `robertknight/tesseract-wasm` (lightweight alternative), `mwilliamson/mammoth.js` (DOCX import), `harshankur/officeParser` (multi-format with AST — evaluate). Claude API for OCR post-correction, image description, reading order detection.
- [ ] OCR pipeline: Tesseract.js integration with Web Worker
- [ ] Scanned PDF auto-detection (image-only page → trigger OCR)
- [ ] Google Cloud Vision API fallback for low-confidence pages
- [ ] Claude-powered OCR post-correction
- [ ] Vision-based reading order detection for scanned multi-column layouts
- [ ] Image description via Claude vision
- [ ] Text aesthetic description
- [ ] Computer-vision click resolution for complex layouts
- [ ] DOCX, RTF, and DAISY importer completion
- [ ] Heading/outline navigation sidebar with bookmarks and highlights

### Phase 6 — Polish and Performance
**Key repos:** `@supabase/supabase-js` (Auth, Realtime sync, reading position persistence), `supabase/supabase` (Edge Functions for server-side processing)
- [ ] Supabase Storage audio cache (persist synthesized blocks across sessions)
- [ ] Supabase Auth and multi-device sync via Realtime
- [ ] **Reading position persistence:**
  - [ ] Auto-save snapshot to Supabase every paragraph
  - [ ] Save on pause, tab blur, and beforeunload
  - [ ] localStorage backup for unclean shutdown
  - [ ] Restore flow on document open ("Resume from where you left off?")
  - [ ] Defensive restore: handle re-imported docs, missing AST nodes, changed speed
- [ ] **Input mappings:**
  - [ ] Full keyboard shortcut set (see §10i default mappings)
  - [ ] Touch gesture support (two-finger swipes, pinch, long-press)
  - [ ] Media Session API for Bluetooth headphones and OS media keys
  - [ ] User-customizable key bindings stored in Supabase
- [ ] Sleep timer (duration-based + end-of-chapter mode, volume fade-out)
- [ ] Focused reading mode (pinch to activate, auto-scroll, dimmed surroundings)
- [ ] Speed ramping (gradual acceleration on play)
- [ ] Previous/Next document navigation (playlist support)
- [ ] Screen reader accessibility of the UI itself (ARIA, focus management)
- [ ] Adaptive block sizing based on network/compute conditions

### Phase 7 — Browser Extension
**Key repos:** `@mozilla/readability` (article extraction), `@met4citizen/headtts` (TTS in offscreen document/service worker), Chrome Extensions MV3 docs. Study Speechify Chrome extension patterns.
- [ ] Content script: Readability.js article extraction → AST pipeline
- [ ] Floating player (shadow DOM, Speechify-style transport bar)
- [ ] Highlight overlay on live DOM elements
- [ ] Click-to-read and text-selection-to-read
- [ ] Hover-to-listen mode (optional)
- [ ] Service worker: HeadTTS + libsonic in offscreen document
- [ ] Extension popup: speed/voice/style controls
- [ ] "Save to Library" — persist web articles to Supabase
- [ ] Chrome (MV3), Firefox, Safari, Edge builds
- [ ] IndexedDB audio cache for offline extension playback

### Phase 8 — Desktop and Mobile
- [ ] **Desktop (Tauri):**
  - [ ] Native file system access (drag-and-drop, file associations)
  - [ ] System-wide global hotkey: select text anywhere → Voxium reads
  - [ ] System tray icon with quick controls
  - [ ] Native notifications for reading queue
- [ ] **Mobile (Capacitor):**
  - [ ] Background audio playback
  - [ ] Lock-screen / notification controls
  - [ ] Share sheet integration
  - [ ] Camera-based OCR (scan physical pages)
  - [ ] Offline document + audio download

### Phase 9 — OpenClaw Accessibility Integration
- [ ] OpenClaw skill: `voxium-reader` — route agent text/markdown output through Voxium Engine
- [ ] Structured data narration (tables, JSON, task lists → accessible audio)
- [ ] File attachment handling (agent-fetched PDFs, emails → full Voxium Reader)
- [ ] Proactive message handling (urgent interrupts + queued-for-pause)
- [ ] Voice-first input loop (Whisper transcription → OpenClaw → Voxium response)
- [ ] Custom navigation units for conversation history (agent_message, user_command, task_boundary)
- [ ] Conversation history persistence and replay

### Phase 10 — Accessible Reference Management (Future)
- [ ] Library manager: collections, tags, smart folders
- [ ] Metadata auto-extraction from PDFs via Claude API
- [ ] DOI / CrossRef / ORCID lookup and enrichment
- [ ] Citation extraction and citation graph construction
- [ ] BibTeX, RIS, Zotero import/export
- [ ] pgvector semantic search: "find papers similar to this one"
- [ ] Full-text search via tsvector across entire library
- [ ] AI-generated document summaries
- [ ] Citation style formatting (CSL processor)
- [ ] Shared collections and team libraries (RLS policies)
- [ ] Accessible citation graph navigation (auditory browsing)

---

## Key Design Decisions and Rationale

**Why simulation, not estimation, for word timings?**
Libsonic is a non-linear, content-aware algorithm. It doesn't uniformly compress audio by a fixed ratio — it makes per-pitch-period decisions about which segments to overlap or drop. Voiced consonants, unvoiced fricatives, silence gaps, and vowels are all treated differently. Dividing original timings by the speed factor produces an approximation that drifts from reality, especially at extreme speeds (4-6x). Even a few milliseconds of cumulative drift causes the highlighting cursor to land on the wrong word. By running libsonic on the actual audio and measuring output lengths word-by-word, we get ground-truth timings that are perfectly synchronized. The cost is negligible — libsonic processes hours of audio in seconds, so simulating a paragraph block takes <5ms.

**Why blocks instead of streaming?**
Streaming audio in real-time means any speed change requires re-synthesizing from the current position. With blocks, speed changes only need re-stretching + re-simulation (instant via libsonic), and the raw HeadTTS audio is cached.

**Why libsonic instead of Web Audio playbackRate?**
Web Audio's `playbackRate` raises pitch proportionally. At 4x, speech sounds like chipmunks and is unintelligible. Libsonic maintains pitch while adjusting speed, and is specifically optimized for extreme speech speed-ups (4-6x).

**Why HeadTTS specifically?**
It's the only browser-compatible TTS that returns word-level timing data alongside audio. Without timings, synchronized highlighting requires a separate forced-alignment step. HeadTTS gives us both in one pass. The timings serve as the input to the simulation — we know where each word starts in the original audio, then we measure where it ends up after stretching.

**Why computer vision for click resolution?**
PDFs and scanned documents don't have reliable DOM elements to click. Bounding boxes from import cover 90% of cases, but complex layouts (multi-column, marginalia, wrapped figures) need visual understanding. Claude vision handles these edge cases.

**Why not stream from the cloud?**
Latency. A round-trip to a TTS API takes 200-500ms. At 900 WPM, the user is consuming ~15 words per second. Any perceptible delay when seeking or changing speed would break the reading flow. Local synthesis + local stretching = zero-latency playback once blocks are ready.

**Why an AudioWorklet boundary emitter instead of polling?**
At 900 WPM, each word lasts ~65ms. A `requestAnimationFrame` poll at 60fps fires every ~16ms — only 4 checks per word. A single main-thread hiccup (GC pause, React re-render, DOM highlight update) can cause the poll to miss a word boundary entirely, making the highlight skip from word 7 to word 9. The AudioWorklet runs in the Web Audio rendering thread, which is isolated from the main thread's event loop and immune to these jank sources. It fires boundary events at audio-clock precision (~2.67ms resolution), guaranteeing that no boundary is ever missed regardless of main-thread load.

**Why a state machine between the emitter and the highlighting engine?**
Separation of concerns and efficiency. The emitter fires raw boundary events. The state machine walks the AST hierarchy once and determines which higher-level boundaries (clause, sentence, paragraph) also changed. Listeners filter by `changedLevels`, so the paragraph highlight (which changes every ~5 seconds) ignores the 15/s word events. The state machine is also the single coordination point for block transitions, reading progress persistence, auto-pause features, and analytics — none of which should be tangled into the highlighting code.

**Why predictive pre-scheduling on top of the authoritative events?**
The AudioWorklet boundary messages arrive asynchronously via `MessagePort` with 1-20ms of variable latency. At 900 WPM, even 10ms of delay means the user hears the next word before seeing it highlighted. Pre-scheduling transitions using `setTimeout` against the simulated timings eliminates this perceptual lag. The AudioWorklet events then serve as drift-correction checkpoints — if the JS timer drifts from the audio clock, the next boundary event resyncs the schedule. The user sees perfectly smooth highlighting with zero perceptible lag.

---

## File Structure

```
voxium-reader/
├── src/
│   ├── app/                    # React app shell, routing
│   ├── components/
│   │   ├── PlainTextView/      # Clean text display + highlighting
│   │   ├── OriginalFormatView/ # Rendered document container
│   │   ├── HighlightOverlay/   # SVG/Canvas multi-layer highlights
│   │   ├── TransportBar/       # Play/pause, rewind/forward, speed, scrubber, footer
│   │   ├── NavUnitPicker/      # Navigation unit selector (long-press popup)
│   │   ├── SpeedControl/       # Speed slider, presets, WPM display
│   │   ├── ProgressScrubber/   # Draggable progress bar with preview tooltip
│   │   ├── StylePackageEditor/  # Style package editor: voice assignment, auditory formatting,
│   │   │                        #   emotional config, pause mapping, master sliders, preview
│   │   ├── PronunciationDict/  # Pronunciation rule editor UI
│   │   ├── AnnotationTools/    # Highlight, comment, sticky note, bookmark, audio note
│   │   ├── AnnotationToolbar/  # Contextual toolbar on text selection (colors, comment, record, tag)
│   │   ├── AudioRecorder/      # Audio annotation recording UI + waveform indicator
│   │   ├── AnnotationExport/   # Export dialog: format, grouping, filters
│   │   ├── OutlineSidebar/     # Heading tree + bookmarks + highlights
│   │   ├── SleepTimerDialog/   # Sleep timer configuration
│   │   ├── FocusedReadingView/ # Focused/distraction-free reading mode
│   │   ├── GoToDialog/         # Jump to page/chapter/percentage
│   │   ├── KeyBindingEditor/   # User-customizable keyboard shortcuts
│   │   └── RestorePrompt/      # "Resume where you left off?" dialog
│   ├── engine/
│   │   ├── ast/                # Unified Document AST types + builders
│   │   ├── importers/          # PDF, EPUB, DOCX, RTF, DAISY, HTML, OCR
│   │   ├── ocr/
│   │   │   ├── ocrPipeline.ts      # Tesseract.js + Cloud Vision orchestration
│   │   │   ├── readingOrder.ts     # Vision-based reading order detection
│   │   │   └── postCorrection.ts   # Claude-powered OCR error correction
│   │   ├── speech/
│   │   │   ├── headtts.ts      # HeadTTS wrapper
│   │   │   ├── libsonic.ts     # WASM libsonic wrapper
│   │   │   ├── simulation.ts   # Stretch simulation for ground-truth timings
│   │   │   ├── blockBuffer.ts  # Block generation + cache manager
│   │   │   ├── voiceMapper.ts  # Layer A: attribute → voice rule engine
│   │   │   └── alignment.ts    # Forced alignment for alt voices
│   │   ├── expressive/
│   │   │   ├── auditoryFormatter.ts     # Layer B: format → AuditoryStyle resolution
│   │   │   ├── emotionalAnalyzer.ts     # Layer C: Claude API emotional analysis
│   │   │   ├── emotionStyleMap.ts       # Emotion → AuditoryStyle mapping tables
│   │   │   ├── pauseMapper.ts           # Whitespace → silence token injection
│   │   │   ├── stylePackages.ts         # StylePackage types + built-in defaults
│   │   │   ├── styleMerger.ts           # mergeStyles(), rule stacking logic
│   │   │   ├── synthesisInstructions.ts # computeSynthesisInstructions() per word
│   │   │   ├── earconManager.ts         # Pre-load and mix earcon audio cues
│   │   │   └── audioProcessingChain.ts  # Web Audio Gain/EQ/Compressor/Reverb chain
│   │   ├── awareness/
│   │   │   ├── boundaryEmitter.worklet.ts  # AudioWorklet boundary detector
│   │   │   ├── stateMachine.ts             # ReadingPositionStateMachine
│   │   │   └── predictiveScheduler.ts      # Pre-schedule + drift correction
│   │   ├── playback/
│   │   │   ├── playbackController.ts   # Single entry point for all state transitions
│   │   │   ├── audioGraph.ts           # Web Audio graph management
│   │   │   ├── snapshot.ts             # PlaybackSnapshot capture + restore
│   │   │   └── positionPersistence.ts  # Supabase + localStorage auto-save
│   │   ├── navigation/
│   │   │   ├── navigationController.ts  # Rewind/forward by navigation unit
│   │   │   ├── navigationUnits.ts       # Unit types + boundary finding logic
│   │   │   ├── bookmarkManager.ts       # Bookmark CRUD + navigation
│   │   │   ├── sleepTimer.ts            # Duration + end-of-chapter sleep timer
│   │   │   ├── focusedReading.ts        # Focused reading mode state + view logic
│   │   │   ├── pronunciationDict.ts     # Pronunciation rules engine
│   │   │   ├── speedController.ts       # Speed presets, ramping, fine adjustment
│   │   │   └── inputMapper.ts           # Keyboard, gesture, Media Session bindings
│   │   ├── highlight/
│   │   │   ├── highlighter.ts  # Multi-layer highlight engine
│   │   │   └── layers.ts       # Layer configuration
│   │   ├── annotations/
│   │   │   ├── annotationManager.ts      # CRUD, sync, rendering for all annotation types
│   │   │   ├── audioAnnotationManager.ts # Recording, storage, inline playback
│   │   │   ├── inlineAudioPlayer.ts      # Inline playback during reading (§7e)
│   │   │   ├── annotationExporter.ts     # Export to Markdown/HTML/JSON/CSV/PDF/DOCX
│   │   │   ├── highlightColors.ts        # Color config with semantic labels
│   │   │   └── annotationSearch.ts       # Full-text search across annotations
│   │   └── vision/
│   │       ├── clickResolver.ts    # CV-based click → word mapping
│   │       ├── imageDescriber.ts   # Image description via Claude
│   │       └── aestheticDescriber.ts
│   ├── services/
│   │   ├── supabase.ts         # Auth, Postgres, Storage, Realtime client
│   │   ├── gcs.ts              # GCS upload/download/cache
│   │   ├── replicate.ts        # Alt TTS, vision models
│   │   └── claude.ts           # Text segmentation, descriptions
│   ├── stores/                 # Zustand state stores
│   ├── wasm/
│   │   ├── sonic.wasm          # Compiled libsonic
│   │   └── sonic.js            # Emscripten glue
│   └── workers/
│       ├── ttsWorker.ts        # Web Worker for HeadTTS inference
│       ├── stretchWorker.ts    # Web Worker for libsonic processing
│       └── simulationWorker.ts # Web Worker for timing simulation
├── public/
├── scripts/
│   └── build-wasm.sh           # Libsonic WASM build script
├── supabase/
│   ├── migrations/          # SQL migration files
│   └── config.toml           # Supabase project config
├── vite.config.ts
├── package.json
└── README.md
```
