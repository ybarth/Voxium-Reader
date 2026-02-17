/**
 * Playback Controller
 * 
 * Main orchestrator for playback state, block buffer management,
 * audio graph control, and reading position updates.
 */

import { create } from 'zustand';
import type { DocumentNode, PlaybackState, ReadingPosition, SpeechBlock, WordTiming } from '../ast/types';
import { getAllWords, buildNodeIndex, findWordAtOffset } from '../ast/utils';
import { BlockBufferManager } from '../speech/blockBuffer';
import { WebAudioGraph, webAudioGraph } from './audioGraph';
import { ReadingPositionStateMachine, readingPositionStateMachine } from '../awareness/stateMachine';

export type ControllerState = 'idle' | 'loading' | 'playing' | 'paused' | 'seeking';

export interface PlaybackStore {
  // State
  controllerState: ControllerState;
  speed: number;
  volume: number;
  document: DocumentNode | null;
  currentBlockId: string | null;
  totalWords: number;
  currentWordIndex: number;
  durationMs: number;
  positionMs: number;
  
  // Actions
  setControllerState: (state: ControllerState) => void;
  setSpeed: (speed: number) => void;
  setVolume: (volume: number) => void;
  setDocument: (doc: DocumentNode | null) => void;
  setCurrentBlock: (blockId: string | null) => void;
  setProgress: (wordIndex: number, positionMs: number) => void;
  setDuration: (durationMs: number) => void;
}

// Zustand store for reactive UI updates
export const usePlaybackStore = create<PlaybackStore>((set) => ({
  controllerState: 'idle',
  speed: 1.0,
  volume: 1.0,
  document: null,
  currentBlockId: null,
  totalWords: 0,
  currentWordIndex: 0,
  durationMs: 0,
  positionMs: 0,
  
  setControllerState: (state) => set({ controllerState: state }),
  setSpeed: (speed) => set({ speed }),
  setVolume: (volume) => set({ volume }),
  setDocument: (doc) => set({ 
    document: doc, 
    totalWords: doc ? getAllWords(doc).length : 0 
  }),
  setCurrentBlock: (blockId) => set({ currentBlockId: blockId }),
  setProgress: (wordIndex, positionMs) => set({ currentWordIndex: wordIndex, positionMs }),
  setDuration: (durationMs) => set({ durationMs }),
}));

export class PlaybackController {
  private audioGraph: WebAudioGraph;
  private stateMachine: ReadingPositionStateMachine;
  private blockBuffer: BlockBufferManager | null = null;
  
  private document: DocumentNode | null = null;
  private nodeIndex: Map<string, DocumentNode> = new Map();
  private allWords: DocumentNode[] = [];
  
  private currentBlock: SpeechBlock | null = null;
  private currentBlockIndex: number = 0;
  private blocks: SpeechBlock[] = [];
  
  private speed: number = 1.0;
  private isInitialized: boolean = false;
  
  constructor(
    audioGraph: WebAudioGraph = webAudioGraph,
    stateMachine: ReadingPositionStateMachine = readingPositionStateMachine
  ) {
    this.audioGraph = audioGraph;
    this.stateMachine = stateMachine;
    
    // Subscribe to reading position updates for UI sync
    this.stateMachine.subscribe((position) => {
      if (position.astNodeId) {
        const wordIndex = this.allWords.findIndex(w => w.id === position.astNodeId);
        if (wordIndex >= 0) {
          usePlaybackStore.getState().setProgress(
            wordIndex,
            position.blockOffsetMs
          );
        }
      }
    });
  }
  
  /**
   * Initialize the playback controller
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;
    
    await this.audioGraph.initialize();
    
    // Handle boundary events from audio graph
    this.audioGraph.onBoundary((event) => {
      this.stateMachine.onBoundaryEvent(event);
    });
    
    // Handle block ended - advance to next block
    this.audioGraph.onEnded(() => {
      this.onBlockEnded();
    });
    
    this.isInitialized = true;
  }
  
  /**
   * Load a document for playback
   */
  async loadDocument(document: DocumentNode): Promise<void> {
    await this.initialize();
    
    usePlaybackStore.getState().setControllerState('loading');
    
    this.document = document;
    this.nodeIndex = buildNodeIndex(document);
    this.allWords = getAllWords(document);
    
    // Create block buffer manager
    this.blockBuffer = new BlockBufferManager(document, this.speed);
    
    // Pre-generate blocks
    this.blocks = this.blockBuffer.createBlocks();
    
    // Estimate total duration (rough, will refine as blocks generate)
    const avgWordsPerMinute = 150 * this.speed;
    const estimatedDurationMs = (this.allWords.length / avgWordsPerMinute) * 60 * 1000;
    usePlaybackStore.getState().setDuration(estimatedDurationMs);
    
    usePlaybackStore.getState().setDocument(document);
    usePlaybackStore.getState().setControllerState('idle');
  }
  
  /**
   * Start playback from a specific word
   */
  async playFromWord(wordId: string): Promise<void> {
    if (!this.document || !this.blockBuffer) return;
    
    await this.initialize();
    usePlaybackStore.getState().setControllerState('loading');
    
    // Find which block contains this word
    const wordIndex = this.allWords.findIndex(w => w.id === wordId);
    if (wordIndex < 0) return;
    
    const block = this.blockBuffer.findBlockContaining(wordId);
    if (!block) return;
    
    // Generate the block if not already
    await this.prepareBlock(block);
    
    // Find the word's position within the block
    const blockWordIndex = block.wordIds.indexOf(wordId);
    const stretchedTimings = block.stretchedTimings?.[this.speed];
    
    if (!stretchedTimings || !block.stretchedAudio?.[this.speed]) {
      console.error('Block not ready for playback');
      return;
    }
    
    // Find the sample offset for this word
    const wordTiming = stretchedTimings[blockWordIndex];
    const startSample = Math.round((wordTiming.startMs * this.audioGraph.getSampleRate()) / 1000);
    
    // Load and play
    await this.audioGraph.loadBuffer(block.stretchedAudio[this.speed], startSample);
    this.audioGraph.loadTimings(stretchedTimings, block.id);
    this.audioGraph.seekToSample(startSample);
    
    this.currentBlock = block;
    this.currentBlockIndex = this.blocks.indexOf(block);
    
    usePlaybackStore.getState().setCurrentBlock(block.id);
    
    // Set initial position
    this.stateMachine.setPositionImmediate({
      blockId: block.id,
      astNodeId: wordId,
      wordIndexInBlock: blockWordIndex,
      blockOffsetMs: wordTiming.startMs,
    });
    
    // Start playback
    this.audioGraph.play();
    usePlaybackStore.getState().setControllerState('playing');
    
    // Prefetch adjacent blocks
    this.blockBuffer.prefetchOutward(block.id, this.speed);
  }
  
  /**
   * Start playback from the beginning or current position
   */
  async play(): Promise<void> {
    const state = usePlaybackStore.getState().controllerState;
    
    if (state === 'paused') {
      // Resume from paused position
      this.audioGraph.resume();
      usePlaybackStore.getState().setControllerState('playing');
    } else if (state === 'idle' && this.document) {
      // Start from beginning
      const firstWord = this.allWords[0];
      if (firstWord) {
        await this.playFromWord(firstWord.id);
      }
    }
  }
  
  /**
   * Pause playback
   */
  pause(): void {
    if (usePlaybackStore.getState().controllerState !== 'playing') return;
    
    this.audioGraph.pause();
    usePlaybackStore.getState().setControllerState('paused');
  }
  
  /**
   * Resume playback
   */
  resume(): void {
    if (usePlaybackStore.getState().controllerState !== 'paused') return;
    
    this.audioGraph.resume();
    usePlaybackStore.getState().setControllerState('playing');
  }
  
  /**
   * Toggle play/pause
   */
  togglePlayPause(): void {
    const state = usePlaybackStore.getState().controllerState;
    if (state === 'playing') {
      this.pause();
    } else {
      this.play();
    }
  }
  
  /**
   * Stop playback and reset position
   */
  stop(): void {
    this.audioGraph.stopImmediately();
    this.currentBlock = null;
    this.currentBlockIndex = 0;
    
    usePlaybackStore.getState().setControllerState('idle');
    usePlaybackStore.getState().setCurrentBlock(null);
    usePlaybackStore.getState().setProgress(0, 0);
  }
  
  /**
   * Change playback speed
   */
  async setSpeed(newSpeed: number): Promise<void> {
    // Clamp speed to valid range
    newSpeed = Math.max(0.5, Math.min(6, newSpeed));
    
    const oldSpeed = this.speed;
    this.speed = newSpeed;
    usePlaybackStore.getState().setSpeed(newSpeed);
    
    if (!this.blockBuffer || !this.currentBlock) return;
    
    const wasPlaying = usePlaybackStore.getState().controllerState === 'playing';
    
    // Get current position before changing
    const currentPosition = this.stateMachine.getPosition();
    if (!currentPosition) return;
    
    // Notify block buffer of speed change (triggers re-stretch)
    await this.blockBuffer.onSpeedChange(oldSpeed, newSpeed);
    
    // Re-prepare current block at new speed
    await this.prepareBlock(this.currentBlock);
    
    // If we were playing, restart from current word
    if (wasPlaying && currentPosition.astNodeId) {
      await this.playFromWord(currentPosition.astNodeId);
    }
  }
  
  /**
   * Set volume
   */
  setVolume(volume: number): void {
    volume = Math.max(0, Math.min(1, volume));
    this.audioGraph.setVolume(volume);
    usePlaybackStore.getState().setVolume(volume);
  }
  
  /**
   * Skip to next sentence
   */
  async skipForward(): Promise<void> {
    const currentPosition = this.stateMachine.getPosition();
    if (!currentPosition?.astNodeId || !this.document) return;
    
    const currentWordIndex = this.allWords.findIndex(w => w.id === currentPosition.astNodeId);
    if (currentWordIndex < 0) return;
    
    // Find next sentence boundary
    const currentWord = this.allWords[currentWordIndex];
    const currentSentenceId = this.findParentSentence(currentWord);
    
    // Find first word of next sentence
    for (let i = currentWordIndex + 1; i < this.allWords.length; i++) {
      const word = this.allWords[i];
      const sentenceId = this.findParentSentence(word);
      if (sentenceId !== currentSentenceId) {
        await this.playFromWord(word.id);
        return;
      }
    }
  }
  
  /**
   * Skip to previous sentence
   */
  async skipBackward(): Promise<void> {
    const currentPosition = this.stateMachine.getPosition();
    if (!currentPosition?.astNodeId || !this.document) return;
    
    const currentWordIndex = this.allWords.findIndex(w => w.id === currentPosition.astNodeId);
    if (currentWordIndex <= 0) return;
    
    // Find current sentence start
    const currentWord = this.allWords[currentWordIndex];
    const currentSentenceId = this.findParentSentence(currentWord);
    
    // Find first word of current sentence
    let sentenceStartIndex = currentWordIndex;
    while (sentenceStartIndex > 0) {
      const word = this.allWords[sentenceStartIndex - 1];
      const sentenceId = this.findParentSentence(word);
      if (sentenceId !== currentSentenceId) break;
      sentenceStartIndex--;
    }
    
    // If we're not at the start, go to start of current sentence
    if (currentWordIndex > sentenceStartIndex + 2) {
      await this.playFromWord(this.allWords[sentenceStartIndex].id);
      return;
    }
    
    // Otherwise, go to previous sentence
    if (sentenceStartIndex > 0) {
      const prevWord = this.allWords[sentenceStartIndex - 1];
      const prevSentenceId = this.findParentSentence(prevWord);
      
      // Find start of previous sentence
      let prevSentenceStart = sentenceStartIndex - 1;
      while (prevSentenceStart > 0) {
        const word = this.allWords[prevSentenceStart - 1];
        const sentenceId = this.findParentSentence(word);
        if (sentenceId !== prevSentenceId) break;
        prevSentenceStart--;
      }
      
      await this.playFromWord(this.allWords[prevSentenceStart].id);
    }
  }
  
  /**
   * Seek to a specific progress (0-1)
   */
  async seekToProgress(progress: number): Promise<void> {
    if (!this.document || this.allWords.length === 0) return;
    
    progress = Math.max(0, Math.min(1, progress));
    const wordIndex = Math.floor(progress * (this.allWords.length - 1));
    const word = this.allWords[wordIndex];
    
    if (word) {
      await this.playFromWord(word.id);
    }
  }
  
  /**
   * Get current progress (0-1)
   */
  getProgress(): number {
    if (this.allWords.length === 0) return 0;
    const { currentWordIndex } = usePlaybackStore.getState();
    return currentWordIndex / (this.allWords.length - 1);
  }
  
  /**
   * Get current reading position
   */
  getPosition(): ReadingPosition | null {
    return this.stateMachine.getPosition();
  }
  
  /**
   * Subscribe to position changes
   */
  subscribeToPosition(callback: (position: ReadingPosition) => void): () => void {
    return this.stateMachine.subscribe(callback);
  }
  
  // Private helpers
  
  private async prepareBlock(block: SpeechBlock): Promise<void> {
    if (!this.blockBuffer) return;
    
    // Check if block has audio at current speed
    if (!block.stretchedAudio?.[this.speed]) {
      await this.blockBuffer.generateBlock(block.id, this.speed);
    }
  }
  
  private async onBlockEnded(): Promise<void> {
    // Advance to next block
    if (this.currentBlockIndex < this.blocks.length - 1) {
      this.currentBlockIndex++;
      const nextBlock = this.blocks[this.currentBlockIndex];
      
      if (nextBlock.wordIds.length > 0) {
        await this.playFromWord(nextBlock.wordIds[0]);
      }
    } else {
      // Document ended
      this.stop();
    }
  }
  
  private findParentSentence(word: DocumentNode): string | null {
    // Walk up the node tree to find sentence
    for (const [id, node] of this.nodeIndex) {
      if (node.type === 'sentence' && node.children?.some(c => c.id === word.id)) {
        return id;
      }
    }
    // Check paragraphs for sentences containing this word
    for (const [id, node] of this.nodeIndex) {
      if (node.type === 'paragraph') {
        for (const sentence of node.children || []) {
          if (sentence.type === 'sentence' && sentence.children?.some(c => c.id === word.id)) {
            return sentence.id;
          }
        }
      }
    }
    return null;
  }
  
  /**
   * Clean up resources
   */
  destroy(): void {
    this.audioGraph.destroy();
    this.document = null;
    this.nodeIndex.clear();
    this.allWords = [];
    this.blocks = [];
    this.currentBlock = null;
    this.blockBuffer = null;
  }
}

// Export singleton instance
export const playbackController = new PlaybackController();
