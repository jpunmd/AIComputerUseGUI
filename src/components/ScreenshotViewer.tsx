import { Monitor, ZoomIn, ZoomOut, Download } from 'lucide-react';
import { useState } from 'react';
import { Coordinate } from '../types';

interface ScreenshotViewerProps {
  screenshot: string | null;
  highlightPoint?: Coordinate | null;
  isLoading?: boolean;
}

export function ScreenshotViewer({
  screenshot,
  highlightPoint,
  isLoading = false,
}: ScreenshotViewerProps) {
  const [zoom, setZoom] = useState(1);

  const handleZoomIn = () => setZoom((prev) => Math.min(prev + 0.25, 3));
  const handleZoomOut = () => setZoom((prev) => Math.max(prev - 0.25, 0.5));
  const handleDownload = () => {
    if (screenshot) {
      const link = document.createElement('a');
      link.href = `data:image/png;base64,${screenshot}`;
      link.download = `screenshot-${Date.now()}.png`;
      link.click();
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-dark-700 bg-dark-900/50">
        <div className="flex items-center gap-2">
          <Monitor className="w-4 h-4 text-dark-400" />
          <span className="text-sm text-dark-300">Screenshot Preview</span>
        </div>
        
        <div className="flex items-center gap-1">
          <button
            onClick={handleZoomOut}
            disabled={zoom <= 0.5 || !screenshot}
            className="p-1.5 rounded-lg hover:bg-dark-700 text-dark-400 hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Zoom Out"
          >
            <ZoomOut className="w-4 h-4" />
          </button>
          <span className="px-2 text-xs text-dark-400 min-w-[3rem] text-center">
            {Math.round(zoom * 100)}%
          </span>
          <button
            onClick={handleZoomIn}
            disabled={zoom >= 3 || !screenshot}
            className="p-1.5 rounded-lg hover:bg-dark-700 text-dark-400 hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Zoom In"
          >
            <ZoomIn className="w-4 h-4" />
          </button>
          <div className="w-px h-4 bg-dark-600 mx-1" />
          <button
            onClick={handleDownload}
            disabled={!screenshot}
            className="p-1.5 rounded-lg hover:bg-dark-700 text-dark-400 hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Download"
          >
            <Download className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Image container */}
      <div className="flex-1 overflow-hidden p-4 bg-dark-950/50 flex items-center justify-center">
        {isLoading ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <div className="w-12 h-12 border-4 border-primary-500/30 border-t-primary-500 rounded-full animate-spin mx-auto" />
              <p className="text-dark-400 mt-4">Capturing screenshot...</p>
            </div>
          </div>
        ) : screenshot ? (
          <div className="relative w-full h-full flex items-center justify-center overflow-hidden">
            <div
              className="relative border border-dark-600 rounded-lg overflow-hidden shadow-2xl"
              style={{ transform: `scale(${zoom})`, transformOrigin: 'center' }}
            >
              <img
                src={`data:image/png;base64,${screenshot}`}
                alt="Screen capture"
                className="max-w-full max-h-full object-contain"
              />
              
              {/* Highlight point overlay */}
              {highlightPoint && (
                <div
                  className="absolute w-8 h-8 -translate-x-1/2 -translate-y-1/2 pointer-events-none"
                  style={{ left: highlightPoint.x, top: highlightPoint.y }}
                >
                  <div className="absolute inset-0 bg-primary-500/30 rounded-full animate-ping" />
                  <div className="absolute inset-2 bg-primary-500 rounded-full" />
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-center h-full">
            <div className="text-center text-dark-500">
              <Monitor className="w-16 h-16 mx-auto mb-4 opacity-30" />
              <p>No screenshot captured</p>
              <p className="text-sm mt-1">
                Enter a command to capture and analyze the screen
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
