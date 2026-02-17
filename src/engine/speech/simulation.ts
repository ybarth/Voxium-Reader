/**
 * Timing Simulation Module
 * 
 * Generates ground-truth word timings by simulating libsonic stretch.
 * This is critical: libsonic is non-linear, so we can't estimate timings
 * by dividing original durations by speed factor. We must measure actual output.
 */

import type { WordTiming, SimulatedTimings } from '../ast/types';
import {
  createStream,
  setSpeed,
  writeToStream,
  readFromStream,
  flushStream,
  destroyStream,
  type SonicStreamHandle,
} from './libsonic';

/**
 * Simulate time-stretching and produce ground-truth word timings.
 * 
 * This function runs libsonic on audio word-by-word, measuring actual
 * output sample counts to determine real timings at the given speed.
 * 
 * @param rawAudio Original unstretched audio (Float32Array)
 * @param originalTimings Word timings from TTS at 1x speed
 * @param speedFactor Target speed (e.g., 3.0 for 3x)
 * @param sampleRate Audio sample rate (e.g., 24000)
 * @returns Ground-truth timings after stretching
 */
export async function simulateStretch(
  rawAudio: Float32Array,
  originalTimings: WordTiming[],
  speedFactor: number,
  sampleRate: number
): Promise<SimulatedTimings> {
  // Create a sonic stream
  const stream = createStream(sampleRate, 1);
  setSpeed(stream, speedFactor);
  
  const simulatedTimings: WordTiming[] = [];
  let totalOutputSamples = 0;
  
  // Process each word's audio segment
  for (let i = 0; i < originalTimings.length; i++) {
    const current = originalTimings[i];
    const next = originalTimings[i + 1];
    
    // Calculate sample range for this word (including trailing gap to next word)
    const startSample = Math.floor((current.startMs * sampleRate) / 1000);
    const endSample = next
      ? Math.floor((next.startMs * sampleRate) / 1000)
      : rawAudio.length;
    
    // Extract this word's audio segment
    const wordAudio = rawAudio.slice(startSample, endSample);
    
    // Track output samples before writing
    const outputBefore = totalOutputSamples;
    
    // Write this word's audio into the sonic stream
    writeToStream(stream, wordAudio);
    
    // Read all available output
    const outputChunk = readFromStream(stream);
    totalOutputSamples += outputChunk.length;
    
    // Calculate actual timing for this word
    const startMs = (outputBefore / sampleRate) * 1000;
    const durationMs = (outputChunk.length / sampleRate) * 1000;
    
    simulatedTimings.push({
      word: current.word,
      startMs,
      durationMs,
      astNodeId: current.astNodeId,
    });
  }
  
  // Flush remaining audio
  flushStream(stream);
  const remaining = readFromStream(stream);
  totalOutputSamples += remaining.length;
  
  // Adjust last word to include flushed tail
  if (simulatedTimings.length > 0 && remaining.length > 0) {
    const lastTiming = simulatedTimings[simulatedTimings.length - 1];
    lastTiming.durationMs += (remaining.length / sampleRate) * 1000;
  }
  
  // Clean up
  destroyStream(stream);
  
  const blockDurationMs = (totalOutputSamples / sampleRate) * 1000;
  
  return {
    blockDurationMs,
    wordTimings: simulatedTimings,
    simulationSpeedFactor: speedFactor,
  };
}

/**
 * Stretch audio and return both the stretched audio and simulated timings.
 * This is the full pipeline for a speech block.
 */
export async function stretchWithTimings(
  rawAudio: Float32Array,
  originalTimings: WordTiming[],
  speedFactor: number,
  sampleRate: number
): Promise<{
  stretchedAudio: Float32Array;
  simulated: SimulatedTimings;
}> {
  // Create a sonic stream for the full audio stretch
  const fullStream = createStream(sampleRate, 1);
  setSpeed(fullStream, speedFactor);
  writeToStream(fullStream, rawAudio);
  flushStream(fullStream);
  const stretchedAudio = readFromStream(fullStream);
  destroyStream(fullStream);
  
  // Simulate to get timings (uses its own stream)
  const simulated = await simulateStretch(
    rawAudio,
    originalTimings,
    speedFactor,
    sampleRate
  );
  
  return { stretchedAudio, simulated };
}

/**
 * Re-simulate timings at a new speed without re-stretching audio.
 * Used when speed changes and we only need new timing data.
 */
export async function resimulateTimings(
  rawAudio: Float32Array,
  originalTimings: WordTiming[],
  newSpeedFactor: number,
  sampleRate: number
): Promise<SimulatedTimings> {
  return simulateStretch(rawAudio, originalTimings, newSpeedFactor, sampleRate);
}

/**
 * Convert simulated word timings to sample offsets for the AudioWorklet.
 * The worklet needs absolute sample positions to fire boundary events.
 */
export function timingsToSampleOffsets(
  timings: WordTiming[],
  sampleRate: number
): { sampleOffset: number; astNodeId: string }[] {
  return timings.map(timing => ({
    sampleOffset: Math.round((timing.startMs * sampleRate) / 1000),
    astNodeId: timing.astNodeId,
  }));
}

/**
 * Estimate block duration at a given speed without full simulation.
 * This is a rough estimate for prefetch planning - not for actual timing.
 */
export function estimateBlockDuration(
  originalDurationMs: number,
  speedFactor: number
): number {
  // Simple estimate - actual will vary due to libsonic's non-linear processing
  return originalDurationMs / speedFactor;
}
