/**
 * AST Utility Functions
 * 
 * Provides traversal, querying, and manipulation utilities for the document AST.
 */

import type { DocumentNode, DocumentAST, NodeType } from './types';

/**
 * Build a flat index of all nodes by ID for O(1) lookup
 */
export function buildNodeIndex(ast: DocumentAST): Map<string, DocumentNode> {
  const index = new Map<string, DocumentNode>();
  
  function traverse(node: DocumentNode) {
    index.set(node.id, node);
    if (node.children) {
      for (const child of node.children) {
        traverse(child);
      }
    }
  }
  
  traverse(ast.root);
  return index;
}

/**
 * Get a node by ID from the index
 */
export function getNode(index: Map<string, DocumentNode>, id: string): DocumentNode | undefined {
  return index.get(id);
}

/**
 * Find the ancestor of a node with the specified type
 */
export function findAncestor(
  index: Map<string, DocumentNode>,
  ast: DocumentAST,
  nodeId: string,
  ancestorType: NodeType
): DocumentNode | undefined {
  // Build parent map if not cached
  const parentMap = buildParentMap(ast);
  
  let currentId = parentMap.get(nodeId);
  while (currentId) {
    const current = index.get(currentId);
    if (current?.type === ancestorType) {
      return current;
    }
    currentId = parentMap.get(currentId);
  }
  
  return undefined;
}

/**
 * Build a map of child ID -> parent ID for ancestor traversal
 */
export function buildParentMap(ast: DocumentAST): Map<string, string> {
  const parentMap = new Map<string, string>();
  
  function traverse(node: DocumentNode, parentId?: string) {
    if (parentId) {
      parentMap.set(node.id, parentId);
    }
    if (node.children) {
      for (const child of node.children) {
        traverse(child, node.id);
      }
    }
  }
  
  traverse(ast.root);
  return parentMap;
}

/**
 * Get all word nodes in document order
 */
export function getAllWords(ast: DocumentAST): DocumentNode[] {
  const words: DocumentNode[] = [];
  
  function traverse(node: DocumentNode) {
    if (node.type === 'word') {
      words.push(node);
    }
    if (node.children) {
      for (const child of node.children) {
        traverse(child);
      }
    }
  }
  
  traverse(ast.root);
  return words;
}

/**
 * Get the first word node within a container node
 */
export function getFirstWordOf(node: DocumentNode): DocumentNode | undefined {
  if (node.type === 'word') {
    return node;
  }
  if (node.children) {
    for (const child of node.children) {
      const result = getFirstWordOf(child);
      if (result) return result;
    }
  }
  return undefined;
}

/**
 * Get the last word node within a container node
 */
export function getLastWordOf(node: DocumentNode): DocumentNode | undefined {
  if (node.type === 'word') {
    return node;
  }
  if (node.children) {
    for (let i = node.children.length - 1; i >= 0; i--) {
      const result = getLastWordOf(node.children[i]);
      if (result) return result;
    }
  }
  return undefined;
}

/**
 * Find the previous sibling node of the same type
 */
export function getPreviousSibling(
  ast: DocumentAST,
  index: Map<string, DocumentNode>,
  nodeId: string,
  nodeType: NodeType
): DocumentNode | undefined {
  const parentMap = buildParentMap(ast);
  const parentId = parentMap.get(nodeId);
  
  if (!parentId) return undefined;
  
  const parent = index.get(parentId);
  if (!parent?.children) return undefined;
  
  const siblings = parent.children.filter(c => c.type === nodeType);
  const currentIndex = siblings.findIndex(c => c.id === nodeId);
  
  if (currentIndex > 0) {
    return siblings[currentIndex - 1];
  }
  
  return undefined;
}

/**
 * Find the next sibling node of the same type
 */
export function getNextSibling(
  ast: DocumentAST,
  index: Map<string, DocumentNode>,
  nodeId: string,
  nodeType: NodeType
): DocumentNode | undefined {
  const parentMap = buildParentMap(ast);
  const parentId = parentMap.get(nodeId);
  
  if (!parentId) return undefined;
  
  const parent = index.get(parentId);
  if (!parent?.children) return undefined;
  
  const siblings = parent.children.filter(c => c.type === nodeType);
  const currentIndex = siblings.findIndex(c => c.id === nodeId);
  
  if (currentIndex >= 0 && currentIndex < siblings.length - 1) {
    return siblings[currentIndex + 1];
  }
  
  return undefined;
}

/**
 * Find the node containing a given plain text offset
 */
export function findNodeAtOffset(
  ast: DocumentAST,
  offset: number
): DocumentNode | undefined {
  function traverse(node: DocumentNode): DocumentNode | undefined {
    const [start, end] = node.plainTextRange;
    if (offset < start || offset >= end) {
      return undefined;
    }
    
    // Check children first for more specific match
    if (node.children) {
      for (const child of node.children) {
        const result = traverse(child);
        if (result) return result;
      }
    }
    
    // Return this node if it contains the offset
    return node;
  }
  
  return traverse(ast.root);
}

/**
 * Find the word node at or nearest to a given plain text offset
 */
export function findWordAtOffset(
  ast: DocumentAST,
  offset: number
): DocumentNode | undefined {
  const words = getAllWords(ast);
  
  // Find exact match or nearest word
  let nearestWord: DocumentNode | undefined;
  let nearestDistance = Infinity;
  
  for (const word of words) {
    const [start, end] = word.plainTextRange;
    
    // Exact match
    if (offset >= start && offset < end) {
      return word;
    }
    
    // Track nearest
    const distance = Math.min(Math.abs(offset - start), Math.abs(offset - end));
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestWord = word;
    }
  }
  
  return nearestWord;
}

/**
 * Count words between two word nodes
 */
export function wordsBetween(
  ast: DocumentAST,
  startNodeId: string,
  endNodeId: string
): number {
  const words = getAllWords(ast);
  const startIndex = words.findIndex(w => w.id === startNodeId);
  const endIndex = words.findIndex(w => w.id === endNodeId);
  
  if (startIndex < 0 || endIndex < 0) return 0;
  
  return Math.abs(endIndex - startIndex);
}

/**
 * Get the first word in the document
 */
export function getFirstWordNode(ast: DocumentAST): DocumentNode | undefined {
  return getFirstWordOf(ast.root);
}

/**
 * Get the last word in the document
 */
export function getLastWordNode(ast: DocumentAST): DocumentNode | undefined {
  return getLastWordOf(ast.root);
}

/**
 * Get the previous word in document order
 */
export function getPreviousWord(
  ast: DocumentAST,
  index: Map<string, DocumentNode>,
  wordId: string
): DocumentNode | undefined {
  const words = getAllWords(ast);
  const currentIndex = words.findIndex(w => w.id === wordId);
  
  if (currentIndex > 0) {
    return words[currentIndex - 1];
  }
  
  return undefined;
}

/**
 * Get the next word in document order
 */
export function getNextWord(
  ast: DocumentAST,
  index: Map<string, DocumentNode>,
  wordId: string
): DocumentNode | undefined {
  const words = getAllWords(ast);
  const currentIndex = words.findIndex(w => w.id === wordId);
  
  if (currentIndex >= 0 && currentIndex < words.length - 1) {
    return words[currentIndex + 1];
  }
  
  return undefined;
}

/**
 * Extract plain text from a range of AST nodes
 */
export function extractTextBetween(
  ast: DocumentAST,
  index: Map<string, DocumentNode>,
  startNodeId: string,
  endNodeId: string
): string {
  const startNode = index.get(startNodeId);
  const endNode = index.get(endNodeId);
  
  if (!startNode || !endNode) return '';
  
  const words = getAllWords(ast);
  const startIndex = words.findIndex(w => w.id === startNodeId);
  const endIndex = words.findIndex(w => w.id === endNodeId);
  
  if (startIndex < 0 || endIndex < 0) return '';
  
  const selectedWords = words.slice(
    Math.min(startIndex, endIndex),
    Math.max(startIndex, endIndex) + 1
  );
  
  return selectedWords.map(w => w.text).join(' ');
}
