/**
 * Plain Text Importer
 * 
 * Parses plain text documents into the Unified AST structure.
 * Splits text into paragraphs → sentences → words, with accurate plainTextRange mappings.
 */

import { v4 as uuid } from 'uuid';
import type { DocumentNode, DocumentAST, DocumentMetadata } from '../ast/types';

/**
 * Simple sentence boundary detection using common patterns.
 * In Phase 2, this will be replaced with Claude-powered clause/sentence segmentation.
 */
function splitIntoSentences(text: string): string[] {
  // Match sentence-ending punctuation followed by space or end of string
  const sentencePattern = /[^.!?]*[.!?]+(?:\s+|$)|[^.!?]+$/g;
  const matches = text.match(sentencePattern);
  
  if (!matches) return [text];
  
  return matches
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

/**
 * Split text into words, preserving the original whitespace pattern
 * for accurate offset calculation.
 */
function splitIntoWords(text: string): { word: string; start: number; end: number }[] {
  const words: { word: string; start: number; end: number }[] = [];
  const wordPattern = /\S+/g;
  
  let match;
  while ((match = wordPattern.exec(text)) !== null) {
    words.push({
      word: match[0],
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  
  return words;
}

/**
 * Parse plain text into a DocumentAST
 */
export function parsePlainText(
  text: string,
  title?: string
): DocumentAST {
  // Normalize line endings
  const normalizedText = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  
  // Split into paragraphs by double newlines
  const paragraphTexts = normalizedText
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(p => p.length > 0);
  
  const paragraphNodes: DocumentNode[] = [];
  let globalOffset = 0;
  let totalWords = 0;
  
  for (const paragraphText of paragraphTexts) {
    const paragraphStartOffset = globalOffset;
    const sentenceNodes: DocumentNode[] = [];
    
    const sentences = splitIntoSentences(paragraphText);
    let paragraphLocalOffset = 0;
    
    for (const sentenceText of sentences) {
      const sentenceStartOffset = globalOffset;
      const wordInfos = splitIntoWords(sentenceText);
      
      const wordNodes: DocumentNode[] = wordInfos.map((info) => {
        const wordStartOffset = sentenceStartOffset + info.start;
        const wordEndOffset = sentenceStartOffset + info.end;
        totalWords++;
        
        return {
          id: uuid(),
          type: 'word' as const,
          text: info.word,
          plainTextRange: [wordStartOffset, wordEndOffset] as [number, number],
        };
      });
      
      const sentenceEndOffset = sentenceStartOffset + sentenceText.length;
      
      sentenceNodes.push({
        id: uuid(),
        type: 'sentence' as const,
        children: wordNodes,
        plainTextRange: [sentenceStartOffset, sentenceEndOffset] as [number, number],
      });
      
      // Account for the sentence text plus any trailing whitespace
      globalOffset += sentenceText.length;
      paragraphLocalOffset += sentenceText.length;
      
      // Add space between sentences if not at end
      if (sentences.indexOf(sentenceText) < sentences.length - 1) {
        globalOffset += 1; // Space between sentences
        paragraphLocalOffset += 1;
      }
    }
    
    const paragraphEndOffset = globalOffset;
    
    paragraphNodes.push({
      id: uuid(),
      type: 'paragraph' as const,
      children: sentenceNodes,
      plainTextRange: [paragraphStartOffset, paragraphEndOffset] as [number, number],
    });
    
    // Account for paragraph break (double newline)
    globalOffset += 2;
  }
  
  // Create root document node
  const documentNode: DocumentNode = {
    id: uuid(),
    type: 'document',
    children: paragraphNodes,
    plainTextRange: [0, globalOffset],
  };
  
  // Build metadata
  const metadata: DocumentMetadata = {
    title: title || 'Untitled Document',
    sourceFormat: 'txt',
    language: 'en', // Default, could be detected
  };
  
  return {
    root: documentNode,
    metadata,
    totalCharacters: globalOffset,
    totalWords,
  };
}

/**
 * Extract the full plain text from an AST (for verification)
 */
export function extractPlainText(ast: DocumentAST): string {
  const parts: string[] = [];
  
  function traverse(node: DocumentNode) {
    if (node.type === 'word' && node.text) {
      parts.push(node.text);
    }
    if (node.children) {
      for (const child of node.children) {
        traverse(child);
      }
    }
  }
  
  traverse(ast.root);
  return parts.join(' ');
}
