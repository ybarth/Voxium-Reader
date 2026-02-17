/**
 * AudioWorklet Boundary Emitter
 * 
 * Runs in the Web Audio rendering thread for audio-clock precision boundary detection.
 * At 900 WPM (~65ms/word), main thread polling at 60fps can miss boundaries.
 * This worklet fires events at ~2.67ms intervals, guaranteed by the audio clock.
 */

interface TimingEntry {
  sampleOffset: number;
  astNodeId: string;
  boundaries: string[]; // Which boundaries this word starts: ['word'] or ['word','sentence']
}

interface BoundaryEventData {
  type: 'word' | 'clause' | 'sentence' | 'paragraph' | 'page' | 'block_end';
  astNodeId: string;
  blockId: string;
  indexInBlock: number;
  audioTimestampMs: number;
}

class BoundaryEmitterProcessor extends AudioWorkletProcessor {
  private timings: TimingEntry[] = [];
  private currentIndex: number = 0;
  private sampleCounter: number = 0;
  private blockId: string = '';
  private active: boolean = false;
  
  constructor() {
    super();
    
    this.port.onmessage = (e: MessageEvent) => {
      const { command, timings, blockId, sampleOffset } = e.data;
      
      switch (command) {
        case 'loadTimings':
          // Receive pre-computed timing array for a block
          this.timings = timings || [];
          this.blockId = blockId || '';
          this.currentIndex = 0;
          this.sampleCounter = 0;
          this.active = true;
          break;
          
        case 'seek':
          // Jump to a specific sample position
          this.sampleCounter = sampleOffset || 0;
          this.currentIndex = this.findIndexAtSample(this.sampleCounter);
          break;
          
        case 'stop':
          this.active = false;
          break;
          
        case 'reset':
          this.timings = [];
          this.currentIndex = 0;
          this.sampleCounter = 0;
          this.blockId = '';
          this.active = false;
          break;
      }
    };
  }
  
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    _parameters: Record<string, Float32Array>
  ): boolean {
    // Pass audio through unchanged (we only observe, not modify)
    const input = inputs[0];
    const output = outputs[0];
    
    if (input && output) {
      for (let channel = 0; channel < output.length; channel++) {
        const inputChannel = input[channel];
        const outputChannel = output[channel];
        if (inputChannel && outputChannel) {
          outputChannel.set(inputChannel);
        }
      }
    }
    
    // Check for boundary crossings if active
    if (!this.active || this.timings.length === 0) {
      return true;
    }
    
    const frameSamples = input?.[0]?.length || 128;
    const frameEndSample = this.sampleCounter + frameSamples;
    
    // Check if any boundaries fall within this frame
    while (
      this.currentIndex < this.timings.length &&
      this.timings[this.currentIndex].sampleOffset < frameEndSample
    ) {
      const entry = this.timings[this.currentIndex];
      
      // Fire a boundary event for each boundary type this word starts
      for (const boundaryType of entry.boundaries) {
        const event: BoundaryEventData = {
          type: boundaryType as BoundaryEventData['type'],
          astNodeId: entry.astNodeId,
          blockId: this.blockId,
          indexInBlock: this.currentIndex,
          audioTimestampMs: (entry.sampleOffset / sampleRate) * 1000,
        };
        
        this.port.postMessage(event);
      }
      
      this.currentIndex++;
    }
    
    // Detect block end
    if (this.currentIndex >= this.timings.length && this.active) {
      const lastEntry = this.timings[this.timings.length - 1];
      
      const blockEndEvent: BoundaryEventData = {
        type: 'block_end',
        astNodeId: lastEntry?.astNodeId ?? '',
        blockId: this.blockId,
        indexInBlock: this.timings.length - 1,
        audioTimestampMs: (this.sampleCounter / sampleRate) * 1000,
      };
      
      this.port.postMessage(blockEndEvent);
      this.active = false;
    }
    
    this.sampleCounter = frameEndSample;
    return true;
  }
  
  private findIndexAtSample(sample: number): number {
    // Binary search for the timing entry at or just after this sample
    let lo = 0;
    let hi = this.timings.length - 1;
    
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.timings[mid].sampleOffset < sample) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    
    return lo;
  }
}

registerProcessor('boundary-emitter', BoundaryEmitterProcessor);
