/**
 * HeadTTS Wrapper
 * 
 * Wraps the HeadTTS library for neural text-to-speech synthesis
 * with word-level timestamps using the Kokoro-82M model.
 */

import { HeadTTS } from '@met4citizen/headtts';
import type { WordTiming } from '../ast/types';

export interface TTSOutput {
  audio: Float32Array;
  sampleRate: number;
  words: string[];
  wtimes: number[];
  wdurations: number[];
  phonemes?: string[];
  ptimes?: number[];
  pdurations?: number[];
}

export interface TTSConfig {
  voice?: string;
  language?: string;
  speed?: number;
}

const DEFAULT_VOICE = 'af_bella';
const DEFAULT_LANGUAGE = 'en-us';
const DEFAULT_SPEED = 1;
const SAMPLE_RATE = 24000;

let headttsInstance: HeadTTS | null = null;
let isInitialized = false;
let initPromise: Promise<void> | null = null;

/**
 * Initialize HeadTTS instance with WebGPU/WASM backend
 */
export async function initializeHeadTTS(): Promise<void> {
  if (isInitialized) return;
  if (initPromise) return initPromise;
  
  initPromise = (async () => {
    headttsInstance = new HeadTTS({
      endpoints: ['webgpu', 'wasm'], // Try WebGPU first, fall back to WASM
      languages: ['en-us'],
      voices: [DEFAULT_VOICE],
      audioSampleRate: SAMPLE_RATE,
      splitSentences: false, // We handle our own segmentation
      defaultVoice: DEFAULT_VOICE,
      defaultLanguage: DEFAULT_LANGUAGE,
      defaultSpeed: DEFAULT_SPEED,
      defaultAudioEncoding: 'pcm', // Raw PCM for processing
    });
    
    await headttsInstance.connect();
    isInitialized = true;
  })();
  
  return initPromise;
}

/**
 * Get the HeadTTS instance (initializes if needed)
 */
async function getInstance(): Promise<HeadTTS> {
  if (!isInitialized) {
    await initializeHeadTTS();
  }
  if (!headttsInstance) {
    throw new Error('HeadTTS not initialized');
  }
  return headttsInstance;
}

/**
 * Setup voice configuration
 */
export async function setupVoice(config: TTSConfig): Promise<void> {
  const instance = await getInstance();
  await instance.setup({
    voice: config.voice || DEFAULT_VOICE,
    language: config.language || DEFAULT_LANGUAGE,
    speed: config.speed || DEFAULT_SPEED,
    audioEncoding: 'pcm',
  });
}

/**
 * Synthesize text to speech with word-level timestamps
 */
export async function synthesize(
  text: string,
  config?: TTSConfig
): Promise<TTSOutput> {
  const instance = await getInstance();
  
  // Apply config if provided
  if (config) {
    await setupVoice(config);
  }
  
  // Synthesize the text
  const messages = await instance.synthesize({
    input: text,
  });
  
  // Find the audio message
  const audioMessage = messages.find((m: { type: string }) => m.type === 'audio');
  if (!audioMessage) {
    throw new Error('No audio response from HeadTTS');
  }
  
  const data = audioMessage.data as {
    words: string[];
    wtimes: number[];
    wdurations: number[];
    phonemes?: string[];
    ptimes?: number[];
    pdurations?: number[];
    audio?: ArrayBuffer;
  };
  
  // Get the audio data (PCM 16-bit LE)
  // The audio is typically sent as binary after the metadata
  // For the await approach, it should be included in the message
  let audioBuffer: Float32Array;
  
  if (data.audio) {
    // Convert PCM 16-bit to Float32
    audioBuffer = pcm16ToFloat32(new Int16Array(data.audio));
  } else {
    // If no audio data in message, create empty buffer
    // This shouldn't happen with proper setup
    console.warn('No audio data in HeadTTS response');
    audioBuffer = new Float32Array(0);
  }
  
  return {
    audio: audioBuffer,
    sampleRate: SAMPLE_RATE,
    words: data.words,
    wtimes: data.wtimes,
    wdurations: data.wdurations,
    phonemes: data.phonemes,
    ptimes: data.ptimes,
    pdurations: data.pdurations,
  };
}

/**
 * Convert HeadTTS output to WordTiming array
 */
export function toWordTimings(
  output: TTSOutput,
  astNodeIds: string[]
): WordTiming[] {
  const timings: WordTiming[] = [];
  
  // Map words to AST node IDs
  // Note: HeadTTS may split/merge words differently than our AST
  // We need to align them
  const words = output.words;
  const wtimes = output.wtimes;
  const wdurations = output.wdurations;
  
  // Simple 1:1 mapping for now
  // TODO: Implement smarter alignment for edge cases
  const minLength = Math.min(words.length, astNodeIds.length);
  
  for (let i = 0; i < minLength; i++) {
    timings.push({
      word: words[i].trim(),
      startMs: wtimes[i],
      durationMs: wdurations[i],
      astNodeId: astNodeIds[i],
    });
  }
  
  return timings;
}

/**
 * Get the sample rate used by HeadTTS
 */
export function getSampleRate(): number {
  return SAMPLE_RATE;
}

/**
 * Preload a voice for faster first synthesis
 */
export async function preloadVoice(voiceId: string): Promise<void> {
  const instance = await getInstance();
  await instance.setup({
    voice: voiceId,
    audioEncoding: 'pcm',
  });
}

/**
 * Get list of available voices
 */
export function getAvailableVoices(): string[] {
  // Kokoro voices from the model
  return [
    'af_bella',
    'af_nicole',
    'af_sarah',
    'af_sky',
    'am_adam',
    'am_michael',
    'am_fenrir',
    'bf_emma',
    'bf_isabella',
    'bm_george',
    'bm_lewis',
  ];
}

/**
 * Convert PCM 16-bit to Float32
 */
function pcm16ToFloat32(pcm16: Int16Array): Float32Array {
  const float32 = new Float32Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) {
    float32[i] = pcm16[i] / (pcm16[i] < 0 ? 0x8000 : 0x7FFF);
  }
  return float32;
}

/**
 * Check if HeadTTS is initialized
 */
export function isHeadTTSInitialized(): boolean {
  return isInitialized;
}

/**
 * Destroy the HeadTTS instance
 */
export function destroyHeadTTS(): void {
  if (headttsInstance) {
    headttsInstance.clear();
    headttsInstance = null;
  }
  isInitialized = false;
  initPromise = null;
}
