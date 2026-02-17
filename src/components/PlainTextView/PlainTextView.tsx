/**
 * PlainTextView Component
 * 
 * Renders the document AST with clickable word spans.
 * Clicking a word starts playback from that position.
 * Auto-scrolls to keep the current word visible.
 */

import React, { useCallback, useEffect, useRef } from 'react';
import type { DocumentNode } from '../../engine/ast/types';
import { useHighlightStore } from '../../engine/highlight';
import { playbackController } from '../../engine/playback';
import { HighlightOverlay } from '../HighlightOverlay';
import './PlainTextView.css';

interface PlainTextViewProps {
  document: DocumentNode;
}

export const PlainTextView: React.FC<PlainTextViewProps> = ({ document }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const currentWordId = useHighlightStore((s) => s.currentWordId);
  
  // Auto-scroll to current word
  useEffect(() => {
    if (!currentWordId || !containerRef.current) return;
    
    const wordElement = containerRef.current.querySelector(
      `[data-word-id="${currentWordId}"]`
    ) as HTMLElement | null;
    
    if (!wordElement) return;
    
    // Check if word is visible
    const containerRect = containerRef.current.getBoundingClientRect();
    const wordRect = wordElement.getBoundingClientRect();
    
    const isVisible = 
      wordRect.top >= containerRect.top + 50 &&
      wordRect.bottom <= containerRect.bottom - 50;
    
    if (!isVisible) {
      wordElement.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    }
  }, [currentWordId]);
  
  // Handle word click
  const handleWordClick = useCallback((wordId: string) => {
    playbackController.playFromWord(wordId);
  }, []);
  
  // Render word
  const renderWord = (node: DocumentNode) => {
    const isHighlighted = node.id === currentWordId;
    
    return (
      <span
        key={node.id}
        data-word-id={node.id}
        className={`word ${isHighlighted ? 'word--highlighted' : ''}`}
        onClick={() => handleWordClick(node.id)}
      >
        {node.content}
      </span>
    );
  };
  
  // Render sentence
  const renderSentence = (node: DocumentNode) => {
    return (
      <span key={node.id} className="sentence">
        {node.children?.map((child) => {
          if (child.type === 'word') {
            return renderWord(child);
          }
          return null;
        })}
      </span>
    );
  };
  
  // Render paragraph
  const renderParagraph = (node: DocumentNode) => {
    return (
      <p key={node.id} className="paragraph">
        {node.children?.map((child) => {
          if (child.type === 'sentence') {
            return renderSentence(child);
          } else if (child.type === 'word') {
            return renderWord(child);
          }
          return null;
        })}
      </p>
    );
  };
  
  // Render document tree
  const renderNode = (node: DocumentNode): React.ReactNode => {
    switch (node.type) {
      case 'document':
      case 'chapter':
      case 'section':
        return (
          <div key={node.id} className={`node-${node.type}`}>
            {node.children?.map(renderNode)}
          </div>
        );
      
      case 'heading':
        const HeadingTag = `h${Math.min(node.level || 1, 6)}` as keyof JSX.IntrinsicElements;
        return (
          <HeadingTag key={node.id} className="heading">
            {node.children?.map((child) => {
              if (child.type === 'word') return renderWord(child);
              return null;
            })}
          </HeadingTag>
        );
      
      case 'paragraph':
        return renderParagraph(node);
      
      case 'sentence':
        return renderSentence(node);
      
      case 'word':
        return renderWord(node);
      
      default:
        return null;
    }
  };
  
  return (
    <div ref={containerRef} className="plain-text-view">
      <HighlightOverlay containerRef={containerRef as React.RefObject<HTMLElement>} />
      <div className="plain-text-content">
        {renderNode(document)}
      </div>
    </div>
  );
};

export default PlainTextView;
