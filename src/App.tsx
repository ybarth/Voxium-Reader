/**
 * Voxium Reader - Main App Component
 * 
 * Neural screen reader with synchronized word highlighting.
 */

import { useCallback, useEffect, useState } from 'react';
import type { DocumentNode } from './engine/ast/types';
import { parsePlainText } from './engine/importers/plainTextImporter';
import { parseEpub } from './engine/importers/epubImporter';
import { playbackController, usePlaybackStore } from './engine/playback';
import { highlighter } from './engine/highlight';
import { PlainTextView } from './components/PlainTextView';
import { TransportBar } from './components/TransportBar';
import './App.css';

// Sample text for demo
const SAMPLE_TEXT = `Welcome to Voxium Reader

Voxium Reader is a neural screen reader that provides synchronized word highlighting as it reads your documents aloud. The system uses advanced text-to-speech technology to generate natural-sounding speech, while the highlighting follows along precisely with the audio.

You can adjust the playback speed from 0.5x all the way up to 6x without any pitch distortion. Click on any word to start reading from that position, or use the transport controls at the bottom of the screen.

To get started, click the Play button below or click on any word in the text. You can also load your own documents using the file input above.`;

function App() {
  const [document, setDocument] = useState<DocumentNode | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controllerState = usePlaybackStore((s) => s.controllerState);
  
  // Initialize with sample text on mount
  useEffect(() => {
    const ast = parsePlainText(SAMPLE_TEXT, 'sample');
    setDocument(ast);
    playbackController.loadDocument(ast);
    highlighter.start();
    
    return () => {
      highlighter.stop();
      playbackController.destroy();
    };
  }, []);
  
  // Handle file upload
  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    setIsLoading(true);
    setError(null);
    
    try {
      let ast: DocumentNode;
      
      if (file.name.endsWith('.epub')) {
        const buffer = await file.arrayBuffer();
        ast = await parseEpub(buffer, file.name);
      } else {
        // Treat as plain text
        const text = await file.text();
        ast = parsePlainText(text, file.name);
      }
      
      setDocument(ast);
      await playbackController.loadDocument(ast);
    } catch (err) {
      console.error('Failed to load document:', err);
      setError(err instanceof Error ? err.message : 'Failed to load document');
    } finally {
      setIsLoading(false);
    }
  }, []);
  
  return (
    <div className="app">
      {/* Header */}
      <header className="app-header">
        <h1 className="app-title">Voxium Reader</h1>
        <div className="file-input-wrapper">
          <input
            type="file"
            accept=".txt,.epub"
            onChange={handleFileChange}
            className="file-input"
            id="file-input"
            disabled={isLoading}
          />
          <label htmlFor="file-input" className="file-input-label">
            {isLoading ? 'Loading...' : 'Load Document'}
          </label>
        </div>
      </header>
      
      {/* Error display */}
      {error && (
        <div className="error-banner">
          {error}
        </div>
      )}
      
      {/* Main content */}
      <main className="app-main">
        {document ? (
          <PlainTextView document={document} />
        ) : (
          <div className="loading-placeholder">
            Loading...
          </div>
        )}
      </main>
      
      {/* Transport bar */}
      {document && <TransportBar />}
    </div>
  );
}

export default App;
