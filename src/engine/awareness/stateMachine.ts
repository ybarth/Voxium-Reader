/**
 * Reading Position State Machine
 * 
 * The single source of truth for "where are we right now" in the document.
 * Consumes boundary events from the AudioWorklet and notifies subscribers.
 */

import type { 
  DocumentAST, 
  DocumentNode, 
  BoundaryEvent, 
  ReadingPosition 
} from '../ast/types';
import { 
  buildNodeIndex, 
  buildParentMap, 
  findAncestor, 
  getNode 
} from '../ast/utils';

export type PositionChangeCallback = (
  position: ReadingPosition,
  changedLevels: Set<string>
) => void;

export class ReadingPositionStateMachine {
  private position: ReadingPosition;
  private ast: DocumentAST | null = null;
  private nodeIndex: Map<string, DocumentNode> = new Map();
  private parentMap: Map<string, string> = new Map();
  private listeners: PositionChangeCallback[] = [];
  
  constructor() {
    // Initialize with empty position
    this.position = {
      word: { astNodeId: '', indexInBlock: 0 },
      paragraph: { astNodeId: '' },
      blockId: '',
      audioTimestampMs: 0,
      plainTextOffset: 0,
      progressPercent: 0,
    };
  }
  
  /**
   * Load a document AST for position tracking
   */
  loadDocument(ast: DocumentAST): void {
    this.ast = ast;
    this.nodeIndex = buildNodeIndex(ast);
    this.parentMap = buildParentMap(ast);
    
    // Reset position
    this.position = {
      word: { astNodeId: '', indexInBlock: 0 },
      paragraph: { astNodeId: '' },
      blockId: '',
      audioTimestampMs: 0,
      plainTextOffset: 0,
      progressPercent: 0,
    };
  }
  
  /**
   * Handle boundary event from AudioWorklet
   */
  onBoundaryEvent(event: BoundaryEvent): void {
    if (!this.ast) return;
    
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
    const wordNode = this.nodeIndex.get(event.astNodeId);
    if (wordNode) {
      // Update plain text offset
      this.position.plainTextOffset = wordNode.plainTextRange[0];
      
      // Find enclosing sentence
      const enclosingSentence = findAncestor(
        this.nodeIndex, 
        this.ast, 
        event.astNodeId, 
        'sentence'
      );
      if (enclosingSentence && enclosingSentence.id !== this.position.sentence?.astNodeId) {
        this.position.sentence = { astNodeId: enclosingSentence.id };
        changedLevels.add('sentence');
      }
      
      // Find enclosing paragraph
      const enclosingParagraph = findAncestor(
        this.nodeIndex, 
        this.ast, 
        event.astNodeId, 
        'paragraph'
      );
      if (enclosingParagraph && enclosingParagraph.id !== previousPosition.paragraph?.astNodeId) {
        this.position.paragraph = { astNodeId: enclosingParagraph.id };
        changedLevels.add('paragraph');
      }
      
      // Find enclosing section
      const enclosingSection = findAncestor(
        this.nodeIndex, 
        this.ast, 
        event.astNodeId, 
        'section'
      );
      if (enclosingSection && enclosingSection.id !== this.position.section?.astNodeId) {
        this.position.section = { astNodeId: enclosingSection.id };
        changedLevels.add('section');
      }
    }
    
    // Update progress
    this.position.progressPercent = this.computeProgress();
    
    // Handle block_end
    if (event.type === 'block_end') {
      changedLevels.add('block_end');
    }
    
    // Notify all listeners
    for (const listener of this.listeners) {
      listener(this.position, changedLevels);
    }
  }
  
  /**
   * Set position immediately (for seek operations)
   */
  setPositionImmediate(astNodeId: string, blockId?: string): void {
    if (!this.ast) return;
    
    const wordNode = this.nodeIndex.get(astNodeId);
    if (!wordNode) return;
    
    const changedLevels = new Set<string>(['word']);
    
    this.position.word = {
      astNodeId,
      indexInBlock: 0, // Will be updated when audio starts
    };
    
    if (blockId) {
      this.position.blockId = blockId;
    }
    
    this.position.plainTextOffset = wordNode.plainTextRange[0];
    
    // Find enclosing sentence
    const enclosingSentence = findAncestor(
      this.nodeIndex, 
      this.ast, 
      astNodeId, 
      'sentence'
    );
    if (enclosingSentence) {
      this.position.sentence = { astNodeId: enclosingSentence.id };
      changedLevels.add('sentence');
    }
    
    // Find enclosing paragraph
    const enclosingParagraph = findAncestor(
      this.nodeIndex, 
      this.ast, 
      astNodeId, 
      'paragraph'
    );
    if (enclosingParagraph) {
      this.position.paragraph = { astNodeId: enclosingParagraph.id };
      changedLevels.add('paragraph');
    }
    
    // Find enclosing section
    const enclosingSection = findAncestor(
      this.nodeIndex, 
      this.ast, 
      astNodeId, 
      'section'
    );
    if (enclosingSection) {
      this.position.section = { astNodeId: enclosingSection.id };
      changedLevels.add('section');
    }
    
    this.position.progressPercent = this.computeProgress();
    
    // Notify listeners
    for (const listener of this.listeners) {
      listener(this.position, changedLevels);
    }
  }
  
  /**
   * Subscribe to position changes
   */
  subscribe(callback: PositionChangeCallback): () => void {
    this.listeners.push(callback);
    
    // Return unsubscribe function
    return () => {
      this.listeners = this.listeners.filter(l => l !== callback);
    };
  }
  
  /**
   * Get current position (readonly snapshot)
   */
  getPosition(): Readonly<ReadingPosition> {
    return Object.freeze({ ...this.position });
  }
  
  /**
   * Get the current word node
   */
  getCurrentWordNode(): DocumentNode | undefined {
    return this.nodeIndex.get(this.position.word.astNodeId);
  }
  
  /**
   * Compute reading progress percentage
   */
  private computeProgress(): number {
    if (!this.ast || this.ast.totalCharacters === 0) return 0;
    return (this.position.plainTextOffset / this.ast.totalCharacters) * 100;
  }
  
  /**
   * Clear the state machine
   */
  clear(): void {
    this.ast = null;
    this.nodeIndex.clear();
    this.parentMap.clear();
    this.position = {
      word: { astNodeId: '', indexInBlock: 0 },
      paragraph: { astNodeId: '' },
      blockId: '',
      audioTimestampMs: 0,
      plainTextOffset: 0,
      progressPercent: 0,
    };
  }
}

// Export singleton instance
export const readingPositionStateMachine = new ReadingPositionStateMachine();
