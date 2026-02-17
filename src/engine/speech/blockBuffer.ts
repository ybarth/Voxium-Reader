/**
 * Block Buffer Manager
 * 
 * Manages pre-generation and caching of audio blocks.
 * Key architectural decision: blocks, not streaming.
 * This allows instant speed changes (only re-stretch, no re-synthesis).
 */

import { v4 as uuid } from 'uuid';
import type { DocumentAST, DocumentNode, SpeechBlock, WordTiming } from '../ast/types';
import { getAllWords } from '../ast/utils';
import { synthesize, toWordTimings, getSampleRate, type TTSOutput } from './headtts';
import { stretchWithTimings, resimulateTimings } from './simulation';
import { stretchAudio } from './libsonic';

const DEFAULT_VOICE = 'af_bella';
const MAX_WORDS_PER_BLOCK = 200;
const MIN_WORDS_PER_BLOCK = 50;

export type BlockPriority = 'immediate' | 'prefetch' | 'background';

interface GenerationTask {
  block: SpeechBlock;
  priority: BlockPriority;
  resolve: () => void;
  reject: (error: Error) => void;
}

export class BlockBufferManager {
  private blocks: Map<string, SpeechBlock> = new Map();
  private blockOrder: string[] = [];
  private currentBlockId: string | null = null;
  private currentSpeed: number = 1.0;
  private sampleRate: number = getSampleRate();
  private voiceId: string = DEFAULT_VOICE;
  
  private generationQueue: GenerationTask[] = [];
  private isProcessing: boolean = false;
  
  /**
   * Create blocks from a document AST
   * Segments document into ~200-400 word blocks at paragraph boundaries
   */
  createBlocks(ast: DocumentAST): SpeechBlock[] {
    const words = getAllWords(ast);
    const blocks: SpeechBlock[] = [];
    
    if (words.length === 0) return blocks;
    
    let currentBlockWords: DocumentNode[] = [];
    let currentBlockText = '';
    let blockStartOffset = words[0].plainTextRange[0];
    
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      currentBlockWords.push(word);
      currentBlockText += (currentBlockText ? ' ' : '') + (word.text || '');
      
      // Check if we should end this block
      const isLastWord = i === words.length - 1;
      const hasEnoughWords = currentBlockWords.length >= MIN_WORDS_PER_BLOCK;
      const isTooLong = currentBlockWords.length >= MAX_WORDS_PER_BLOCK;
      
      // End block at paragraph boundary or if too long
      const nextWord = words[i + 1];
      const isParagraphEnd = nextWord && 
        word.plainTextRange[1] < nextWord.plainTextRange[0] - 10; // Gap indicates paragraph break
      
      if (isLastWord || isTooLong || (hasEnoughWords && isParagraphEnd)) {
        const blockEndOffset = word.plainTextRange[1];
        
        const block: SpeechBlock = {
          id: uuid(),
          text: currentBlockText,
          astNodeIds: currentBlockWords.map(w => w.id),
          plainTextRange: [blockStartOffset, blockEndOffset],
          voiceId: this.voiceId,
          priority: 'background',
          status: 'pending',
        };
        
        blocks.push(block);
        this.blocks.set(block.id, block);
        this.blockOrder.push(block.id);
        
        // Reset for next block
        currentBlockWords = [];
        currentBlockText = '';
        if (nextWord) {
          blockStartOffset = nextWord.plainTextRange[0];
        }
      }
    }
    
    return blocks;
  }
  
  /**
   * Generate a block (synthesize + stretch + simulate)
   */
  async generateBlock(block: SpeechBlock, priority: BlockPriority): Promise<void> {
    return new Promise((resolve, reject) => {
      // Update priority if already in queue
      const existingTask = this.generationQueue.find(t => t.block.id === block.id);
      if (existingTask) {
        if (this.comparePriority(priority, existingTask.priority) > 0) {
          existingTask.priority = priority;
          this.sortQueue();
        }
        // Wait for existing task
        existingTask.resolve = () => { resolve(); existingTask.resolve(); };
        return;
      }
      
      // Add to queue
      this.generationQueue.push({ block, priority, resolve, reject });
      this.sortQueue();
      
      // Start processing if not already
      if (!this.isProcessing) {
        this.processQueue();
      }
    });
  }
  
  private sortQueue() {
    this.generationQueue.sort((a, b) => this.comparePriority(b.priority, a.priority));
  }
  
  private comparePriority(a: BlockPriority, b: BlockPriority): number {
    const order: Record<BlockPriority, number> = {
      immediate: 3,
      prefetch: 2,
      background: 1,
    };
    return order[a] - order[b];
  }
  
  private async processQueue() {
    if (this.isProcessing) return;
    this.isProcessing = true;
    
    while (this.generationQueue.length > 0) {
      const task = this.generationQueue.shift()!;
      const { block, resolve, reject } = task;
      
      try {
        await this.doGenerateBlock(block);
        resolve();
      } catch (error) {
        reject(error as Error);
      }
    }
    
    this.isProcessing = false;
  }
  
  private async doGenerateBlock(block: SpeechBlock): Promise<void> {
    if (block.status === 'ready') return;
    
    block.status = 'synthesizing';
    
    try {
      // Step 1: Synthesize with HeadTTS
      const ttsOutput = await synthesize(block.text, { voice: block.voiceId });
      
      // Step 2: Map TTS timings to AST node IDs
      const rawTimings = toWordTimings(ttsOutput, block.astNodeIds);
      
      // Store raw (unstretched) audio and timings
      block.rawAudio = ttsOutput.audio;
      block.rawTimings = rawTimings;
      
      // Step 3: Time-stretch and simulate
      block.status = 'stretching';
      
      const { stretchedAudio, simulated } = await stretchWithTimings(
        ttsOutput.audio,
        rawTimings,
        this.currentSpeed,
        this.sampleRate
      );
      
      // Store stretched audio and simulated timings
      block.audioBuffer = stretchedAudio;
      block.wordTimings = simulated.wordTimings;
      block.duration = simulated.blockDurationMs;
      
      block.status = 'ready';
    } catch (error) {
      block.status = 'error';
      throw error;
    }
  }
  
  /**
   * Find the block containing a specific AST node
   */
  findBlockContaining(astNodeId: string): SpeechBlock | undefined {
    for (const block of this.blocks.values()) {
      if (block.astNodeIds.includes(astNodeId)) {
        return block;
      }
    }
    return undefined;
  }
  
  /**
   * Find block by plain text offset
   */
  findBlockAtOffset(offset: number): SpeechBlock | undefined {
    for (const blockId of this.blockOrder) {
      const block = this.blocks.get(blockId);
      if (block) {
        const [start, end] = block.plainTextRange;
        if (offset >= start && offset < end) {
          return block;
        }
      }
    }
    return undefined;
  }
  
  /**
   * Prefetch blocks outward from a given block
   */
  async prefetchOutward(blockId: string, count: number): Promise<void> {
    const index = this.blockOrder.indexOf(blockId);
    if (index < 0) return;
    
    const blocksToPrefetch: string[] = [];
    
    // Add blocks forward
    for (let i = 1; i <= count && index + i < this.blockOrder.length; i++) {
      blocksToPrefetch.push(this.blockOrder[index + i]);
    }
    
    // Add blocks backward
    for (let i = 1; i <= count && index - i >= 0; i++) {
      blocksToPrefetch.push(this.blockOrder[index - i]);
    }
    
    // Generate them with prefetch priority
    for (const id of blocksToPrefetch) {
      const block = this.blocks.get(id);
      if (block && block.status === 'pending') {
        this.generateBlock(block, 'prefetch').catch(console.error);
      }
    }
  }
  
  /**
   * Handle speed change - re-stretch and re-simulate all cached blocks
   */
  async onSpeedChange(newSpeed: number): Promise<void> {
    if (newSpeed === this.currentSpeed) return;
    
    this.currentSpeed = newSpeed;
    
    // Re-process all ready blocks
    const promises: Promise<void>[] = [];
    
    for (const block of this.blocks.values()) {
      if (block.status === 'ready' && block.rawAudio && block.rawTimings) {
        promises.push(this.restretchBlock(block));
      }
    }
    
    await Promise.all(promises);
  }
  
  private async restretchBlock(block: SpeechBlock): Promise<void> {
    if (!block.rawAudio || !block.rawTimings) return;
    
    // Re-stretch audio
    block.audioBuffer = stretchAudio(block.rawAudio, this.sampleRate, this.currentSpeed);
    
    // Re-simulate timings
    const simulated = await resimulateTimings(
      block.rawAudio,
      block.rawTimings,
      this.currentSpeed,
      this.sampleRate
    );
    
    block.wordTimings = simulated.wordTimings;
    block.duration = simulated.blockDurationMs;
  }
  
  /**
   * Get the current block
   */
  getCurrentBlock(): SpeechBlock | undefined {
    if (!this.currentBlockId) return undefined;
    return this.blocks.get(this.currentBlockId);
  }
  
  /**
   * Set the current block
   */
  setCurrentBlock(blockId: string): void {
    this.currentBlockId = blockId;
  }
  
  /**
   * Get the next block in reading order
   */
  getNextBlock(currentBlockId: string): SpeechBlock | undefined {
    const index = this.blockOrder.indexOf(currentBlockId);
    if (index < 0 || index >= this.blockOrder.length - 1) return undefined;
    return this.blocks.get(this.blockOrder[index + 1]);
  }
  
  /**
   * Get the previous block in reading order
   */
  getPreviousBlock(currentBlockId: string): SpeechBlock | undefined {
    const index = this.blockOrder.indexOf(currentBlockId);
    if (index <= 0) return undefined;
    return this.blocks.get(this.blockOrder[index - 1]);
  }
  
  /**
   * Get a block by ID
   */
  getBlock(blockId: string): SpeechBlock | undefined {
    return this.blocks.get(blockId);
  }
  
  /**
   * Get all blocks
   */
  getAllBlocks(): SpeechBlock[] {
    return this.blockOrder.map(id => this.blocks.get(id)!);
  }
  
  /**
   * Get current speed
   */
  getSpeed(): number {
    return this.currentSpeed;
  }
  
  /**
   * Set voice for new blocks
   */
  setVoice(voiceId: string): void {
    this.voiceId = voiceId;
  }
  
  /**
   * Clear all blocks
   */
  clear(): void {
    this.blocks.clear();
    this.blockOrder = [];
    this.currentBlockId = null;
    this.generationQueue = [];
  }
}

// Export singleton instance
export const blockBufferManager = new BlockBufferManager();
