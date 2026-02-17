/**
 * EPUB Importer
 * 
 * Parses EPUB documents into the Unified AST structure using epub.js.
 * Extracts chapters, preserves structure, and builds plainTextRange mappings.
 */

import ePub, { Book, NavItem } from 'epubjs';
import { v4 as uuid } from 'uuid';
import type { DocumentNode, DocumentAST, DocumentMetadata } from '../ast/types';

/**
 * Simple sentence boundary detection
 */
function splitIntoSentences(text: string): string[] {
  const sentencePattern = /[^.!?]*[.!?]+(?:\s+|$)|[^.!?]+$/g;
  const matches = text.match(sentencePattern);
  
  if (!matches) return [text];
  
  return matches
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

/**
 * Split text into words with position tracking
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
 * Extract text content from HTML string
 */
function extractTextFromHTML(html: string): string {
  // Create a temporary DOM element to parse HTML
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  
  // Get text content, normalizing whitespace
  const text = doc.body.textContent || '';
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Parse HTML content into paragraph nodes
 */
function parseHTMLToNodes(
  html: string,
  startOffset: number
): { nodes: DocumentNode[]; endOffset: number; wordCount: number } {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  
  const paragraphNodes: DocumentNode[] = [];
  let currentOffset = startOffset;
  let totalWords = 0;
  
  // Find all block-level text containers
  const blockElements = doc.body.querySelectorAll('p, h1, h2, h3, h4, h5, h6, div, li');
  
  // If no block elements found, treat the whole body as a single paragraph
  const elements = blockElements.length > 0 
    ? Array.from(blockElements) 
    : [doc.body];
  
  for (const element of elements) {
    const text = (element.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    
    const paragraphStartOffset = currentOffset;
    const sentences = splitIntoSentences(text);
    const sentenceNodes: DocumentNode[] = [];
    
    for (const sentenceText of sentences) {
      const sentenceStartOffset = currentOffset;
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
      
      currentOffset += sentenceText.length;
      
      // Add space between sentences
      if (sentences.indexOf(sentenceText) < sentences.length - 1) {
        currentOffset += 1;
      }
    }
    
    // Determine if this is a heading
    const tagName = element.tagName.toLowerCase();
    const isHeading = /^h[1-6]$/.test(tagName);
    
    paragraphNodes.push({
      id: uuid(),
      type: isHeading ? 'heading' : 'paragraph',
      children: sentenceNodes,
      plainTextRange: [paragraphStartOffset, currentOffset] as [number, number],
      attributes: isHeading ? { level: parseInt(tagName[1]) } : undefined,
    });
    
    // Add paragraph spacing
    currentOffset += 2;
  }
  
  return {
    nodes: paragraphNodes,
    endOffset: currentOffset,
    wordCount: totalWords,
  };
}

/**
 * Parse an EPUB file into a DocumentAST
 */
export async function parseEpub(
  epubData: ArrayBuffer | string
): Promise<DocumentAST> {
  // Load the EPUB
  const book: Book = ePub(epubData);
  await book.ready;
  
  // Get metadata
  const metadata = await book.loaded.metadata;
  const navigation = await book.loaded.navigation;
  
  // Get the spine (reading order)
  const spine = book.spine;
  
  const sectionNodes: DocumentNode[] = [];
  let globalOffset = 0;
  let totalWords = 0;
  let chapterIndex = 0;
  
  // Process each spine item (chapter)
  // @ts-expect-error - epubjs types are incomplete
  for (const spineItem of spine.items) {
    try {
      // Load the chapter content
      const section = book.section(spineItem.href);
      if (!section) continue;
      
      const contents = await section.load(book.load.bind(book));
      const doc = contents as Document;
      const html = doc.body?.innerHTML || '';
      
      if (!html.trim()) continue;
      
      const sectionStartOffset = globalOffset;
      
      // Find chapter title from navigation
      let chapterTitle = `Chapter ${chapterIndex + 1}`;
      if (navigation?.toc) {
        const navItem = navigation.toc.find(
          (item: NavItem) => item.href?.includes(spineItem.href)
        );
        if (navItem?.label) {
          chapterTitle = navItem.label;
        }
      }
      
      // Parse HTML content to nodes
      const { nodes, endOffset, wordCount } = parseHTMLToNodes(html, globalOffset);
      
      if (nodes.length > 0) {
        globalOffset = endOffset;
        totalWords += wordCount;
        
        sectionNodes.push({
          id: uuid(),
          type: 'section',
          children: nodes,
          plainTextRange: [sectionStartOffset, globalOffset] as [number, number],
          attributes: {
            title: chapterTitle,
            chapterIndex,
          },
        });
        
        chapterIndex++;
      }
    } catch (error) {
      console.warn(`Failed to process spine item ${spineItem.href}:`, error);
      continue;
    }
  }
  
  // Create root document node
  const documentNode: DocumentNode = {
    id: uuid(),
    type: 'document',
    children: sectionNodes,
    plainTextRange: [0, globalOffset],
  };
  
  // Build document metadata
  const docMetadata: DocumentMetadata = {
    title: metadata?.title || 'Untitled EPUB',
    author: metadata?.creator,
    sourceFormat: 'epub',
    language: metadata?.language || 'en',
    chapterCount: chapterIndex,
  };
  
  // Clean up
  book.destroy();
  
  return {
    root: documentNode,
    metadata: docMetadata,
    totalCharacters: globalOffset,
    totalWords,
  };
}

/**
 * Load EPUB from a File object
 */
export async function parseEpubFile(file: File): Promise<DocumentAST> {
  const arrayBuffer = await file.arrayBuffer();
  return parseEpub(arrayBuffer);
}

/**
 * Load EPUB from a URL
 */
export async function parseEpubUrl(url: string): Promise<DocumentAST> {
  return parseEpub(url);
}
