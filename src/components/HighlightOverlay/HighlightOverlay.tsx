/**
 * HighlightOverlay Component
 * 
 * Renders the highlight effect over the currently spoken word.
 * Uses CSS transforms for smooth animations.
 */

import React, { useEffect, useRef, useState } from 'react';
import { useHighlightStore } from '../../engine/highlight';
import './HighlightOverlay.css';

interface HighlightOverlayProps {
  containerRef: React.RefObject<HTMLElement>;
}

interface HighlightRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export const HighlightOverlay: React.FC<HighlightOverlayProps> = ({ containerRef }) => {
  const { currentWordId, previousWordId, timestamp } = useHighlightStore();
  const [rect, setRect] = useState<HighlightRect | null>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  
  useEffect(() => {
    if (!currentWordId || !containerRef.current) {
      setRect(null);
      return;
    }
    
    // Find the word element by data-word-id
    const wordElement = containerRef.current.querySelector(
      `[data-word-id="${currentWordId}"]`
    ) as HTMLElement | null;
    
    if (!wordElement) {
      setRect(null);
      return;
    }
    
    // Get position relative to container
    const containerRect = containerRef.current.getBoundingClientRect();
    const wordRect = wordElement.getBoundingClientRect();
    
    setRect({
      top: wordRect.top - containerRect.top + containerRef.current.scrollTop,
      left: wordRect.left - containerRect.left + containerRef.current.scrollLeft,
      width: wordRect.width,
      height: wordRect.height,
    });
  }, [currentWordId, timestamp, containerRef]);
  
  if (!rect) return null;
  
  return (
    <div
      ref={highlightRef}
      className="highlight-overlay"
      style={{
        transform: `translate(${rect.left}px, ${rect.top}px)`,
        width: rect.width,
        height: rect.height,
      }}
    />
  );
};

export default HighlightOverlay;
