/**
 * Highlighter Engine
 * 
 * Subscribes to the reading position state machine and provides
 * highlighting state for React components.
 */

import { create } from 'zustand';
import type { ReadingPosition } from '../ast/types';
import { readingPositionStateMachine } from '../awareness/stateMachine';

export interface HighlightState {
  // Currently highlighted word
  currentWordId: string | null;
  // Previous word (for exit animation)
  previousWordId: string | null;
  // Block ID for context
  currentBlockId: string | null;
  // Timestamp for animation coordination
  timestamp: number;
  
  // Actions
  setHighlight: (wordId: string | null, blockId: string | null) => void;
}

export const useHighlightStore = create<HighlightState>((set, get) => ({
  currentWordId: null,
  previousWordId: null,
  currentBlockId: null,
  timestamp: 0,
  
  setHighlight: (wordId, blockId) => {
    const current = get().currentWordId;
    set({
      previousWordId: current,
      currentWordId: wordId,
      currentBlockId: blockId,
      timestamp: Date.now(),
    });
  },
}));

/**
 * Highlighter class that bridges state machine to highlight store
 */
export class Highlighter {
  private unsubscribe: (() => void) | null = null;
  
  /**
   * Start listening to position updates
   */
  start(): void {
    if (this.unsubscribe) return;
    
    this.unsubscribe = readingPositionStateMachine.subscribe((position) => {
      useHighlightStore.getState().setHighlight(
        position.astNodeId,
        position.blockId
      );
    });
  }
  
  /**
   * Stop listening and clear highlight
   */
  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    useHighlightStore.getState().setHighlight(null, null);
  }
  
  /**
   * Clear highlight without stopping listener
   */
  clear(): void {
    useHighlightStore.getState().setHighlight(null, null);
  }
}

// Export singleton
export const highlighter = new Highlighter();
