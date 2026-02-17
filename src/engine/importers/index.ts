/**
 * Document Importer Service
 * 
 * Auto-detects document format and delegates to the appropriate importer.
 * Provides a unified interface for loading documents into the AST.
 */

import type { DocumentAST } from '../ast/types';
import { parsePlainText, extractPlainText } from './plainTextImporter';
import { parseEpub, parseEpubFile, parseEpubUrl } from './epubImporter';

export type SupportedFormat = 'txt' | 'epub' | 'pdf' | 'docx' | 'html';

export interface ImportOptions {
  title?: string;
  format?: SupportedFormat;
}

/**
 * Detect file format from file extension or MIME type
 */
function detectFormat(file: File): SupportedFormat {
  const extension = file.name.split('.').pop()?.toLowerCase();
  const mimeType = file.type;
  
  if (extension === 'epub' || mimeType === 'application/epub+zip') {
    return 'epub';
  }
  if (extension === 'pdf' || mimeType === 'application/pdf') {
    return 'pdf';
  }
  if (extension === 'docx' || mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return 'docx';
  }
  if (extension === 'html' || extension === 'htm' || mimeType === 'text/html') {
    return 'html';
  }
  
  // Default to plain text
  return 'txt';
}

/**
 * Import a document from a File object
 */
export async function importFile(
  file: File,
  options: ImportOptions = {}
): Promise<DocumentAST> {
  const format = options.format || detectFormat(file);
  const title = options.title || file.name.replace(/\.[^/.]+$/, '');
  
  switch (format) {
    case 'epub':
      return parseEpubFile(file);
    
    case 'txt': {
      const text = await file.text();
      return parsePlainText(text, title);
    }
    
    case 'pdf':
      throw new Error('PDF import not yet implemented (Phase 5)');
    
    case 'docx':
      throw new Error('DOCX import not yet implemented (Phase 5)');
    
    case 'html': {
      // For HTML files, extract text and parse as plain text for now
      const html = await file.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      const text = doc.body.textContent || '';
      return parsePlainText(text, title);
    }
    
    default:
      throw new Error(`Unsupported format: ${format}`);
  }
}

/**
 * Import a document from a text string
 */
export function importText(
  text: string,
  options: ImportOptions = {}
): DocumentAST {
  return parsePlainText(text, options.title);
}

/**
 * Import a document from a URL
 */
export async function importUrl(
  url: string,
  options: ImportOptions = {}
): Promise<DocumentAST> {
  const format = options.format;
  
  if (!format) {
    // Try to detect from URL
    if (url.endsWith('.epub')) {
      return parseEpubUrl(url);
    }
    
    // Fetch and detect from content
    const response = await fetch(url);
    const contentType = response.headers.get('content-type') || '';
    
    if (contentType.includes('epub')) {
      const arrayBuffer = await response.arrayBuffer();
      return parseEpub(arrayBuffer);
    }
    
    // Default to plain text
    const text = await response.text();
    return parsePlainText(text, options.title || url);
  }
  
  switch (format) {
    case 'epub':
      return parseEpubUrl(url);
    
    case 'txt': {
      const response = await fetch(url);
      const text = await response.text();
      return parsePlainText(text, options.title || url);
    }
    
    default:
      throw new Error(`URL import not supported for format: ${format}`);
  }
}

// Re-export utilities
export { extractPlainText } from './plainTextImporter';
