/**
 * Unified Document AST Types
 * 
 * The AST represents a document as a hierarchical tree structure where every node
 * carries both plainTextRange (for clean-text view) and optional boundingBoxes
 * (for original-format view). This dual mapping enables synchronized highlighting
 * and annotation across both views.
 */

export type NodeType = 
  | 'document'
  | 'section'
  | 'heading'
  | 'paragraph'
  | 'sentence'
  | 'clause'
  | 'word'
  | 'image'
  | 'table'
  | 'list'
  | 'footnote';

export interface FormattingInfo {
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: 'normal' | 'bold';
  fontStyle?: 'normal' | 'italic';
  color?: string;
  backgroundColor?: string;
  textDecoration?: string;
  customAttributes?: string[];
}

export interface BoundingBox {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Annotation {
  id: string;
  type: 'highlight' | 'comment' | 'bookmark' | 'audio_note';
  color?: string;
  text?: string;
  createdAt: Date;
}

export interface DocumentNode {
  id: string;
  type: NodeType;
  text?: string;
  children?: DocumentNode[];
  formatting?: FormattingInfo;
  boundingBoxes?: BoundingBox[];
  plainTextRange: [number, number];
  annotations?: Annotation[];
  attributes?: Record<string, unknown>;
}

export interface DocumentAST {
  root: DocumentNode;
  metadata: DocumentMetadata;
  totalCharacters: number;
  totalWords: number;
}

export interface DocumentMetadata {
  title?: string;
  author?: string;
  language?: string;
  sourceFormat: 'txt' | 'epub' | 'pdf' | 'docx' | 'html';
  pageCount?: number;
  chapterCount?: number;
}

/**
 * Word timing information for speech synthesis
 */
export interface WordTiming {
  word: string;
  startMs: number;
  durationMs: number;
  astNodeId: string;
}

/**
 * Simulated timing result from libsonic stretch
 */
export interface SimulatedTimings {
  blockDurationMs: number;
  wordTimings: WordTiming[];
  simulationSpeedFactor: number;
}

/**
 * Speech block for pre-generation and caching
 */
export interface SpeechBlock {
  id: string;
  text: string;
  astNodeIds: string[];
  plainTextRange: [number, number];
  voiceId: string;
  priority: 'immediate' | 'prefetch' | 'background';
  status: 'pending' | 'synthesizing' | 'stretching' | 'ready' | 'error';
  rawAudio?: Float32Array;
  rawTimings?: WordTiming[];
  audioBuffer?: Float32Array;
  wordTimings?: WordTiming[];
  duration?: number;
}

/**
 * Boundary event fired from AudioWorklet
 */
export interface BoundaryEvent {
  type: 'word' | 'clause' | 'sentence' | 'paragraph' | 'page' | 'block_end';
  astNodeId: string;
  blockId: string;
  indexInBlock: number;
  audioTimestampMs: number;
}

/**
 * Reading position tracked by state machine
 */
export interface ReadingPosition {
  word: { astNodeId: string; indexInBlock: number };
  clause?: { astNodeId: string };
  sentence?: { astNodeId: string };
  paragraph: { astNodeId: string };
  section?: { astNodeId: string };
  blockId: string;
  audioTimestampMs: number;
  plainTextOffset: number;
  progressPercent: number;
}

/**
 * Playback state
 */
export type PlaybackState = 
  | 'idle'
  | 'positioned'
  | 'loading'
  | 'playing'
  | 'paused'
  | 'seeking'
  | 'error';

/**
 * Playback snapshot for pause/resume and cross-session restore
 */
export interface PlaybackSnapshot {
  state: PlaybackState;
  documentId: string;
  astNodeId: string;
  blockId: string;
  sampleOffsetInBlock: number;
  speedFactor: number;
  timestamp: Date;
  progressPercent: number;
}
