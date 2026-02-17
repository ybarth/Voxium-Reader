/**
 * Web Audio Graph
 * 
 * Manages the audio playback graph with the boundary emitter worklet
 * in the signal chain for precise timing events.
 */

import type { BoundaryEvent, WordTiming } from '../ast/types';

// AudioWorklet module URL (Vite handles this)
const WORKLET_URL = new URL(
  '../awareness/boundaryEmitter.worklet.ts',
  import.meta.url
).href;

export type AudioGraphState = 'uninitialized' | 'initialized' | 'playing' | 'paused' | 'stopped';

export class WebAudioGraph {
  private audioContext: AudioContext | null = null;
  private boundaryWorklet: AudioWorkletNode | null = null;
  private sourceNode: AudioBufferSourceNode | null = null;
  private gainNode: GainNode | null = null;
  
  private state: AudioGraphState = 'uninitialized';
  private sampleRate: number = 24000;
  private currentBuffer: AudioBuffer | null = null;
  private startTime: number = 0;
  private pauseTime: number = 0;
  
  private boundaryCallback: ((event: BoundaryEvent) => void) | null = null;
  private endedCallback: (() => void) | null = null;
  
  /**
   * Initialize the audio context and worklet
   */
  async initialize(sampleRate: number = 24000): Promise<void> {
    if (this.state !== 'uninitialized') return;
    
    this.sampleRate = sampleRate;
    
    // Create audio context
    this.audioContext = new AudioContext({ sampleRate });
    
    // Create gain node for volume control
    this.gainNode = this.audioContext.createGain();
    this.gainNode.connect(this.audioContext.destination);
    
    // Load the boundary emitter worklet
    try {
      await this.audioContext.audioWorklet.addModule(WORKLET_URL);
      
      // Create worklet node
      this.boundaryWorklet = new AudioWorkletNode(
        this.audioContext,
        'boundary-emitter'
      );
      
      // Connect worklet to gain node
      this.boundaryWorklet.connect(this.gainNode);
      
      // Handle boundary events from the worklet
      this.boundaryWorklet.port.onmessage = (event: MessageEvent) => {
        if (this.boundaryCallback) {
          this.boundaryCallback(event.data as BoundaryEvent);
        }
      };
    } catch (error) {
      console.warn('Failed to load AudioWorklet, using fallback:', error);
      // Fallback: direct connection without worklet
    }
    
    this.state = 'initialized';
  }
  
  /**
   * Load an audio buffer for playback
   */
  async loadBuffer(
    audioData: Float32Array,
    startOffset: number = 0
  ): Promise<void> {
    if (!this.audioContext) {
      await this.initialize();
    }
    
    // Stop any existing playback
    this.stopSource();
    
    // Create audio buffer
    const buffer = this.audioContext!.createBuffer(
      1, // mono
      audioData.length,
      this.sampleRate
    );
    buffer.getChannelData(0).set(audioData);
    this.currentBuffer = buffer;
    
    // Create source node
    this.sourceNode = this.audioContext!.createBufferSource();
    this.sourceNode.buffer = buffer;
    
    // Connect to worklet or directly to gain
    if (this.boundaryWorklet) {
      this.sourceNode.connect(this.boundaryWorklet);
    } else if (this.gainNode) {
      this.sourceNode.connect(this.gainNode);
    }
    
    // Handle playback ended
    this.sourceNode.onended = () => {
      if (this.state === 'playing') {
        this.state = 'stopped';
        if (this.endedCallback) {
          this.endedCallback();
        }
      }
    };
    
    // Calculate start time offset in seconds
    this.pauseTime = startOffset / this.sampleRate;
    this.state = 'initialized';
  }
  
  /**
   * Load timing data into the boundary emitter worklet
   */
  loadTimings(
    wordTimings: WordTiming[],
    blockId: string,
    sampleRate: number = this.sampleRate
  ): void {
    if (!this.boundaryWorklet) return;
    
    // Convert word timings to sample offsets with boundary types
    const timings = wordTimings.map((timing, index) => ({
      sampleOffset: Math.round((timing.startMs * sampleRate) / 1000),
      astNodeId: timing.astNodeId,
      boundaries: ['word'], // For Phase 1, just word boundaries
    }));
    
    this.boundaryWorklet.port.postMessage({
      command: 'loadTimings',
      timings,
      blockId,
    });
  }
  
  /**
   * Seek within the current buffer
   */
  seekToSample(sampleOffset: number): void {
    if (this.boundaryWorklet) {
      this.boundaryWorklet.port.postMessage({
        command: 'seek',
        sampleOffset,
      });
    }
    this.pauseTime = sampleOffset / this.sampleRate;
  }
  
  /**
   * Start/resume playback
   */
  play(): void {
    if (!this.audioContext || !this.currentBuffer) return;
    
    // Resume audio context if suspended
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }
    
    // If we have an existing source that's been used, create a new one
    if (this.state === 'paused' && this.sourceNode) {
      // Create new source for resume (source nodes are one-time-use)
      this.sourceNode = this.audioContext.createBufferSource();
      this.sourceNode.buffer = this.currentBuffer;
      
      if (this.boundaryWorklet) {
        this.sourceNode.connect(this.boundaryWorklet);
      } else if (this.gainNode) {
        this.sourceNode.connect(this.gainNode);
      }
      
      this.sourceNode.onended = () => {
        if (this.state === 'playing') {
          this.state = 'stopped';
          if (this.endedCallback) {
            this.endedCallback();
          }
        }
      };
    }
    
    if (this.sourceNode && this.state !== 'playing') {
      this.startTime = this.audioContext.currentTime - this.pauseTime;
      this.sourceNode.start(0, this.pauseTime);
      this.state = 'playing';
    }
  }
  
  /**
   * Pause playback
   */
  pause(): void {
    if (this.state !== 'playing' || !this.audioContext) return;
    
    // Calculate current position
    this.pauseTime = this.audioContext.currentTime - this.startTime;
    
    // Stop the source
    this.stopSource();
    
    this.state = 'paused';
  }
  
  /**
   * Resume from paused state
   */
  resume(): void {
    if (this.state !== 'paused') return;
    this.play();
  }
  
  /**
   * Stop playback immediately
   */
  stopImmediately(): void {
    this.stopSource();
    
    // Stop the worklet
    if (this.boundaryWorklet) {
      this.boundaryWorklet.port.postMessage({ command: 'stop' });
    }
    
    this.pauseTime = 0;
    this.state = 'stopped';
  }
  
  private stopSource(): void {
    if (this.sourceNode) {
      try {
        this.sourceNode.stop();
        this.sourceNode.disconnect();
      } catch {
        // Ignore errors if already stopped
      }
      this.sourceNode = null;
    }
  }
  
  /**
   * Set volume (0.0 to 1.0)
   */
  setVolume(volume: number): void {
    if (this.gainNode) {
      this.gainNode.gain.value = Math.max(0, Math.min(1, volume));
    }
  }
  
  /**
   * Fade out volume over duration
   */
  async fadeOut(durationMs: number): Promise<void> {
    if (!this.gainNode || !this.audioContext) return;
    
    const currentTime = this.audioContext.currentTime;
    this.gainNode.gain.setValueAtTime(this.gainNode.gain.value, currentTime);
    this.gainNode.gain.linearRampToValueAtTime(0, currentTime + durationMs / 1000);
    
    return new Promise(resolve => setTimeout(resolve, durationMs));
  }
  
  /**
   * Fade in volume over duration
   */
  async fadeIn(durationMs: number, targetVolume: number = 1): Promise<void> {
    if (!this.gainNode || !this.audioContext) return;
    
    const currentTime = this.audioContext.currentTime;
    this.gainNode.gain.setValueAtTime(this.gainNode.gain.value, currentTime);
    this.gainNode.gain.linearRampToValueAtTime(targetVolume, currentTime + durationMs / 1000);
    
    return new Promise(resolve => setTimeout(resolve, durationMs));
  }
  
  /**
   * Get current playback position in samples
   */
  getCurrentSamplePosition(): number {
    if (this.state === 'playing' && this.audioContext) {
      const currentSeconds = this.audioContext.currentTime - this.startTime;
      return Math.floor(currentSeconds * this.sampleRate);
    }
    return Math.floor(this.pauseTime * this.sampleRate);
  }
  
  /**
   * Get current playback position in milliseconds
   */
  getCurrentPositionMs(): number {
    return (this.getCurrentSamplePosition() / this.sampleRate) * 1000;
  }
  
  /**
   * Set callback for boundary events
   */
  onBoundary(callback: (event: BoundaryEvent) => void): void {
    this.boundaryCallback = callback;
  }
  
  /**
   * Set callback for playback ended
   */
  onEnded(callback: () => void): void {
    this.endedCallback = callback;
  }
  
  /**
   * Get current state
   */
  getState(): AudioGraphState {
    return this.state;
  }
  
  /**
   * Get sample rate
   */
  getSampleRate(): number {
    return this.sampleRate;
  }
  
  /**
   * Destroy the audio graph
   */
  destroy(): void {
    this.stopImmediately();
    
    if (this.boundaryWorklet) {
      this.boundaryWorklet.disconnect();
      this.boundaryWorklet = null;
    }
    
    if (this.gainNode) {
      this.gainNode.disconnect();
      this.gainNode = null;
    }
    
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    
    this.state = 'uninitialized';
  }
}

// Export singleton instance
export const webAudioGraph = new WebAudioGraph();
