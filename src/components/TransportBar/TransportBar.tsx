/**
 * TransportBar Component
 * 
 * Provides playback controls:
 * - Play/Pause button
 * - Speed slider (0.5x - 6x)
 * - Progress scrubber
 * - Rewind/Forward buttons (sentence units)
 */

import React, { useCallback, useEffect, useState } from 'react';
import { playbackController, usePlaybackStore } from '../../engine/playback';
import './TransportBar.css';

// Icons as simple SVG components
const PlayIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
    <path d="M8 5v14l11-7z" />
  </svg>
);

const PauseIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
    <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
  </svg>
);

const SkipBackIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
    <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" />
  </svg>
);

const SkipForwardIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
    <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
  </svg>
);

export const TransportBar: React.FC = () => {
  const { 
    controllerState, 
    speed, 
    totalWords, 
    currentWordIndex,
    positionMs,
    durationMs 
  } = usePlaybackStore();
  
  const [isDragging, setIsDragging] = useState(false);
  const [dragProgress, setDragProgress] = useState(0);
  
  const isPlaying = controllerState === 'playing';
  const isLoading = controllerState === 'loading';
  
  // Calculate progress
  const progress = totalWords > 0 ? currentWordIndex / (totalWords - 1) : 0;
  const displayProgress = isDragging ? dragProgress : progress;
  
  // Format time
  const formatTime = (ms: number) => {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };
  
  // Play/Pause toggle
  const handlePlayPause = useCallback(() => {
    playbackController.togglePlayPause();
  }, []);
  
  // Skip backward
  const handleSkipBack = useCallback(() => {
    playbackController.skipBackward();
  }, []);
  
  // Skip forward
  const handleSkipForward = useCallback(() => {
    playbackController.skipForward();
  }, []);
  
  // Speed change
  const handleSpeedChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const newSpeed = parseFloat(e.target.value);
    playbackController.setSpeed(newSpeed);
  }, []);
  
  // Progress scrubber
  const handleProgressMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    setIsDragging(true);
    const rect = e.currentTarget.getBoundingClientRect();
    const progress = (e.clientX - rect.left) / rect.width;
    setDragProgress(Math.max(0, Math.min(1, progress)));
  }, []);
  
  const handleProgressMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging) return;
    const scrubber = document.querySelector('.progress-scrubber') as HTMLElement;
    if (!scrubber) return;
    const rect = scrubber.getBoundingClientRect();
    const progress = (e.clientX - rect.left) / rect.width;
    setDragProgress(Math.max(0, Math.min(1, progress)));
  }, [isDragging]);
  
  const handleProgressMouseUp = useCallback(async () => {
    if (!isDragging) return;
    setIsDragging(false);
    await playbackController.seekToProgress(dragProgress);
  }, [isDragging, dragProgress]);
  
  // Global mouse events for dragging
  useEffect(() => {
    if (isDragging) {
      window.addEventListener('mousemove', handleProgressMouseMove);
      window.addEventListener('mouseup', handleProgressMouseUp);
      return () => {
        window.removeEventListener('mousemove', handleProgressMouseMove);
        window.removeEventListener('mouseup', handleProgressMouseUp);
      };
    }
  }, [isDragging, handleProgressMouseMove, handleProgressMouseUp]);
  
  // Speed presets for display
  const speedLabel = speed === 1 ? '1x' : `${speed.toFixed(1)}x`;
  
  return (
    <div className="transport-bar">
      {/* Progress section */}
      <div className="transport-progress-section">
        <span className="time-display">{formatTime(positionMs)}</span>
        
        <div 
          className="progress-scrubber"
          onMouseDown={handleProgressMouseDown}
        >
          <div 
            className="progress-track"
          >
            <div 
              className="progress-fill" 
              style={{ width: `${displayProgress * 100}%` }}
            />
            <div 
              className="progress-handle"
              style={{ left: `${displayProgress * 100}%` }}
            />
          </div>
        </div>
        
        <span className="time-display">{formatTime(durationMs)}</span>
      </div>
      
      {/* Controls section */}
      <div className="transport-controls">
        {/* Skip back */}
        <button 
          className="transport-button skip-button"
          onClick={handleSkipBack}
          title="Previous sentence"
        >
          <SkipBackIcon />
        </button>
        
        {/* Play/Pause */}
        <button 
          className={`transport-button play-button ${isLoading ? 'loading' : ''}`}
          onClick={handlePlayPause}
          disabled={isLoading}
          title={isPlaying ? 'Pause' : 'Play'}
        >
          {isPlaying ? <PauseIcon /> : <PlayIcon />}
        </button>
        
        {/* Skip forward */}
        <button 
          className="transport-button skip-button"
          onClick={handleSkipForward}
          title="Next sentence"
        >
          <SkipForwardIcon />
        </button>
        
        {/* Speed control */}
        <div className="speed-control">
          <label className="speed-label">{speedLabel}</label>
          <input
            type="range"
            className="speed-slider"
            min="0.5"
            max="6"
            step="0.1"
            value={speed}
            onChange={handleSpeedChange}
            title="Playback speed"
          />
        </div>
        
        {/* Word counter */}
        <div className="word-counter">
          {currentWordIndex + 1} / {totalWords}
        </div>
      </div>
    </div>
  );
};

export default TransportBar;
