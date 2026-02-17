/**
 * Libsonic Wrapper
 * 
 * Wraps the sonic-wasm library for speech time-stretching.
 * Sonic is optimized for speech speed-ups in the 2-6x range.
 */

import { SonicStream, createSonicStream } from '@echogarden/sonic-wasm';

export interface SonicStreamHandle {
  stream: SonicStream;
  sampleRate: number;
  channels: number;
}

let initialized = false;

/**
 * Initialize the sonic WASM module
 */
export async function initializeSonic(): Promise<void> {
  if (initialized) return;
  // The module initializes automatically on first use
  initialized = true;
}

/**
 * Create a new sonic stream for processing audio
 */
export function createStream(
  sampleRate: number,
  channels: number = 1
): SonicStreamHandle {
  const stream = createSonicStream(sampleRate, channels);
  return { stream, sampleRate, channels };
}

/**
 * Set the speed factor for time-stretching
 * @param handle The sonic stream handle
 * @param factor Speed factor (1.0 = normal, 2.0 = 2x faster, etc.)
 */
export function setSpeed(handle: SonicStreamHandle, factor: number): void {
  handle.stream.setSpeed(factor);
}

/**
 * Set the pitch factor (optional, for pitch shifting)
 * @param handle The sonic stream handle
 * @param factor Pitch factor (1.0 = normal)
 */
export function setPitch(handle: SonicStreamHandle, factor: number): void {
  handle.stream.setPitch(factor);
}

/**
 * Set the rate factor (combined speed and pitch)
 * @param handle The sonic stream handle
 * @param factor Rate factor
 */
export function setRate(handle: SonicStreamHandle, factor: number): void {
  handle.stream.setRate(factor);
}

/**
 * Set the volume
 * @param handle The sonic stream handle
 * @param factor Volume factor (1.0 = normal)
 */
export function setVolume(handle: SonicStreamHandle, factor: number): void {
  handle.stream.setVolume(factor);
}

/**
 * Write audio samples to the stream for processing
 * @param handle The sonic stream handle
 * @param samples Float32Array of audio samples
 */
export function writeToStream(
  handle: SonicStreamHandle,
  samples: Float32Array
): void {
  // Convert Float32Array to Int16Array for sonic
  const int16Samples = float32ToInt16(samples);
  handle.stream.writeInt16Samples(int16Samples);
}

/**
 * Read processed audio samples from the stream
 * @param handle The sonic stream handle
 * @returns Float32Array of processed samples, or empty array if no output ready
 */
export function readFromStream(handle: SonicStreamHandle): Float32Array {
  const availableSamples = handle.stream.samplesAvailable();
  if (availableSamples === 0) {
    return new Float32Array(0);
  }
  
  const int16Samples = handle.stream.readInt16Samples(availableSamples);
  return int16ToFloat32(int16Samples);
}

/**
 * Flush the stream to get any remaining samples
 * @param handle The sonic stream handle
 */
export function flushStream(handle: SonicStreamHandle): void {
  handle.stream.flush();
}

/**
 * Destroy the stream and free resources
 * @param handle The sonic stream handle
 */
export function destroyStream(handle: SonicStreamHandle): void {
  // The stream will be garbage collected
  // No explicit destroy needed for the JS wrapper
}

/**
 * Process a complete audio buffer at a given speed factor
 * This is a convenience function for one-shot processing.
 */
export function stretchAudio(
  samples: Float32Array,
  sampleRate: number,
  speedFactor: number
): Float32Array {
  const handle = createStream(sampleRate, 1);
  setSpeed(handle, speedFactor);
  writeToStream(handle, samples);
  flushStream(handle);
  const output = readFromStream(handle);
  destroyStream(handle);
  return output;
}

/**
 * Convert Float32Array (-1.0 to 1.0) to Int16Array
 */
function float32ToInt16(float32: Float32Array): Int16Array {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    // Clamp and convert
    const s = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return int16;
}

/**
 * Convert Int16Array to Float32Array (-1.0 to 1.0)
 */
function int16ToFloat32(int16: Int16Array): Float32Array {
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / (int16[i] < 0 ? 0x8000 : 0x7FFF);
  }
  return float32;
}

export type { SonicStream };
