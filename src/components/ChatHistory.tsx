import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { Message } from '../types';
import { Bot, User, MousePointer, Keyboard, Move, Info, CheckCircle, AlertCircle, StopCircle, X, ZoomIn, ChevronRight, Brain, Crosshair } from 'lucide-react';

interface ChatHistoryProps {
  messages: Message[];
  expandThinkingByDefault?: boolean;
  debugMode?: boolean;
}

// The normalized coordinate space the model emits clicks in. 0..1000 is
// universal across the grounding models this app targets (Qwen3-VL, Gemma).
const COORDINATE_BASE = 1000;

// A precise crosshair reticle, positioned over a screenshot at a normalized
// coordinate (0..COORDINATE_BASE). Positioning by percentage keeps it accurate
// at any rendered image size. `variant` selects the color: red = the model's
// predicted click, cyan = the user's ground-truth target (probe).
function CrosshairMarker({
  coordinate,
  variant = 'predicted',
}: {
  coordinate?: number[];
  variant?: 'predicted' | 'target';
}) {
  if (!coordinate || coordinate.length < 2) return null;
  const leftPct = (coordinate[0] / COORDINATE_BASE) * 100;
  const topPct = (coordinate[1] / COORDINATE_BASE) * 100;
  // Clamp so an out-of-range prediction still renders at the edge rather than
  // overflowing the image box.
  const clamp = (v: number) => Math.max(0, Math.min(100, v));
  const lineColor = variant === 'target' ? 'bg-cyan-400' : 'bg-red-500';
  const ringColor = variant === 'target' ? 'border-cyan-400 bg-cyan-400/10' : 'border-red-500 bg-red-500/10';
  return (
    <span
      className="absolute z-10 pointer-events-none drop-shadow-[0_0_1px_rgba(0,0,0,0.9)]"
      style={{ left: `${clamp(leftPct)}%`, top: `${clamp(topPct)}%` }}
    >
      <span className={`absolute -translate-x-1/2 -translate-y-1/2 h-px w-7 ${lineColor}`} />
      <span className={`absolute -translate-x-1/2 -translate-y-1/2 w-px h-7 ${lineColor}`} />
      <span className={`absolute -translate-x-1/2 -translate-y-1/2 w-3.5 h-3.5 rounded-full border ${ringColor}`} />
    </span>
  );
}

// The pass-2 bounding box [x0,y0,x1,y1] (normalized 0..COORDINATE_BASE) drawn
// as a rectangle over the zoom crop, so you can see whether the model boxed the
// glyph or swallowed the text label. Positioned by percentage like the
// crosshair, so it tracks the image at any rendered size.
function BoxMarker({ box }: { box?: number[] }) {
  if (!box || box.length < 4) return null;
  const x0 = Math.min(box[0], box[2]);
  const y0 = Math.min(box[1], box[3]);
  const x1 = Math.max(box[0], box[2]);
  const y1 = Math.max(box[1], box[3]);
  const pct = (v: number) => (v / COORDINATE_BASE) * 100;
  return (
    <span
      className="absolute z-10 pointer-events-none border border-emerald-400 bg-emerald-400/10 drop-shadow-[0_0_1px_rgba(0,0,0,0.9)]"
      style={{
        left: `${pct(x0)}%`,
        top: `${pct(y0)}%`,
        width: `${pct(x1 - x0)}%`,
        height: `${pct(y1 - y0)}%`,
      }}
    />
  );
}

// Independent least-squares fit of `actual = gain * predicted + bias` for one
// axis. Returns null if the points are degenerate (fewer than 2, or all
// predicted values identical — no slope is determinable).
function fitAxis(predicted: number[], actual: number[]): { gain: number; bias: number } | null {
  const n = predicted.length;
  if (n < 2) return null;
  const meanP = predicted.reduce((a, b) => a + b, 0) / n;
  const meanA = actual.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (predicted[i] - meanP) * (actual[i] - meanA);
    den += (predicted[i] - meanP) ** 2;
  }
  if (den === 0) return null;
  const gain = num / den;
  return { gain, bias: meanA - gain * meanP };
}

export function ChatHistory({ messages, expandThinkingByDefault = false, debugMode = false }: ChatHistoryProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [expandedScreenshot, setExpandedScreenshot] = useState<{ screenshot: string; coordinate?: number[]; box?: number[] } | null>(null);
  // Probe (debug only): ground-truth target the user clicks on the expanded
  // image (normalized 0..COORDINATE_BASE), and the accumulated (predicted,
  // actual) pairs used to fit a coordinate calibration.
  const [groundTruth, setGroundTruth] = useState<number[] | null>(null);
  const [samples, setSamples] = useState<{ predicted: number[]; actual: number[] }[]>([]);

  const openScreenshot = (screenshot: string, coordinate?: number[], box?: number[]) => {
    setGroundTruth(null);
    setExpandedScreenshot({ screenshot, coordinate, box });
  };

  // Translate a click on the expanded image into normalized model-space coords.
  const handleProbeClick = (e: MouseEvent<HTMLImageElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const fx = (e.clientX - rect.left) / rect.width;
    const fy = (e.clientY - rect.top) / rect.height;
    setGroundTruth([fx * COORDINATE_BASE, fy * COORDINATE_BASE]);
  };

  const recordSample = () => {
    const predicted = expandedScreenshot?.coordinate;
    if (!groundTruth || !predicted || predicted.length < 2) return;
    const sample = { predicted: [predicted[0], predicted[1]], actual: groundTruth };
    setSamples(prev => [...prev, sample]);
    console.log('[probe] sample', {
      predicted: sample.predicted,
      actual: sample.actual.map(v => Math.round(v)),
      deltaNorm: [Math.round(groundTruth[0] - predicted[0]), Math.round(groundTruth[1] - predicted[1])],
    });
  };

  const fitX = fitAxis(samples.map(s => s.predicted[0]), samples.map(s => s.actual[0]));
  const fitY = fitAxis(samples.map(s => s.predicted[1]), samples.map(s => s.actual[1]));
  // Per-message override of the default expand state. Undefined = use default.
  const [thinkingOverrides, setThinkingOverrides] = useState<Record<string, boolean>>({});

  const isThinkingExpanded = (id: string) =>
    thinkingOverrides[id] ?? expandThinkingByDefault;

  const toggleThinking = (id: string) => {
    setThinkingOverrides(prev => ({ ...prev, [id]: !isThinkingExpanded(id) }));
  };

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-dark-500">
        <div className="text-center">
          <Bot className="w-12 h-12 mx-auto mb-4 opacity-50" />
          <p>No messages yet</p>
          <p className="text-sm mt-1">Enter a command to get started</p>
        </div>
      </div>
    );
  }

  const getActionIcon = (action?: Message['action']) => {
    if (!action) return null;
    
    switch (action.action) {
      case 'click':
      case 'left_click':
      case 'right_click':
      case 'double_click':
        return <MousePointer className="w-4 h-4" />;
      case 'type':
      case 'key':
        return <Keyboard className="w-4 h-4" />;
      case 'scroll':
      case 'drag':
        return <Move className="w-4 h-4" />;
      default:
        return null;
    }
  };

  const formatAction = (action?: Message['action']) => {
    if (!action) return null;

    let description = action.action || 'action';
    if (action.arguments?.coordinate) {
      description += ` at (${Math.round(action.arguments.coordinate[0])}, ${Math.round(action.arguments.coordinate[1])})`;
    }
    if (action.arguments?.text) {
      description += `: "${action.arguments.text}"`;
    }
    if (action.arguments?.key) {
      description += `: ${action.arguments.key}`;
    }

    return description;
  };

  // Clean up the content - remove tool_call XML tags but keep thinking
  const cleanContent = (content: string) => {
    // Extract text before <tool_call> as the model's thinking
    const toolCallIndex = content.indexOf('<tool_call>');
    let thinking = '';
    
    if (toolCallIndex > 0) {
      thinking = content.substring(0, toolCallIndex).trim();
    }
    
    // Remove <tool_call>...</tool_call> blocks
    let cleaned = content.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
    
    // If we have thinking, use that
    if (thinking) {
      return thinking;
    }
    
    // If nothing left after cleaning, show a friendly message
    if (!cleaned) {
      return 'Action detected';
    }
    return cleaned;
  };

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      {messages.map((message) => (
        <div
          key={message.id}
          className={`flex gap-3 ${message.role === 'user' ? 'flex-row-reverse' : ''} ${message.role === 'system' ? 'justify-center' : ''}`}
        >
          {/* System message styling */}
          {message.role === 'system' ? (
            <div className="flex items-center gap-2 px-4 py-2 bg-dark-800/50 border border-dark-700 rounded-full text-sm">
              {message.content.startsWith('✓') ? (
                <CheckCircle className="w-4 h-4 text-green-400" />
              ) : message.content.startsWith('⚠') ? (
                <AlertCircle className="w-4 h-4 text-yellow-400" />
              ) : message.content.startsWith('⏹') ? (
                <StopCircle className="w-4 h-4 text-red-400" />
              ) : (
                <Info className="w-4 h-4 text-dark-400" />
              )}
              <span className="text-dark-300">{message.content}</span>
            </div>
          ) : (
            <>
              {/* Avatar */}
              <div
                className={`flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center ${
                  message.role === 'user'
                    ? 'bg-primary-500/20'
                    : 'bg-dark-700'
                }`}
              >
                {message.role === 'user' ? (
                  <User className="w-4 h-4 text-primary-400" />
                ) : (
                  <Bot className="w-4 h-4 text-dark-300" />
                )}
              </div>

              {/* Message content */}
              <div
                className={`max-w-[80%] flex flex-col ${
                  message.role === 'user' ? 'items-end text-right' : 'items-start'
                }`}
              >
                {/* Step number badge for multi-turn */}
                {message.stepNumber && (
                  <div className="mb-1">
                    <span className="text-xs px-2 py-0.5 bg-primary-500/20 text-primary-400 rounded-full">
                      Step {message.stepNumber}
                    </span>
                  </div>
                )}

                {/* Thinking block - collapsible, shown before action */}
                {message.role === 'assistant' && message.thinking && (
                  <div className="mb-2 w-full max-w-full">
                    <button
                      onClick={() => toggleThinking(message.id)}
                      className="flex items-center gap-1.5 px-2.5 py-1 bg-dark-800/50 hover:bg-dark-800 border border-dark-700 rounded-lg text-xs text-dark-300 hover:text-dark-100 transition-colors"
                    >
                      <ChevronRight
                        className={`w-3.5 h-3.5 transition-transform ${isThinkingExpanded(message.id) ? 'rotate-90' : ''}`}
                      />
                      <Brain className="w-3.5 h-3.5 text-primary-400" />
                      <span>Thinking</span>
                    </button>
                    {isThinkingExpanded(message.id) && (
                      <div className="mt-1.5 px-3 py-2 bg-dark-900/70 border border-dark-700 rounded-lg text-xs text-dark-300 whitespace-pre-wrap font-mono leading-relaxed max-h-96 overflow-y-auto">
                        {message.thinking}
                      </div>
                    )}
                  </div>
                )}

                <div
                  className={`inline-block px-4 py-2 rounded-2xl ${
                    message.role === 'user'
                      ? 'bg-primary-500 text-white rounded-tr-sm'
                      : 'bg-dark-800 text-dark-100 rounded-tl-sm'
                  }`}
                >
                  <p className="text-sm whitespace-pre-wrap">{message.role === 'assistant' ? cleanContent(message.content) : message.content}</p>
                </div>

                {/* Action badge */}
                {message.action && (
                  <div className="mt-2 inline-flex items-center gap-2 px-3 py-1.5 bg-dark-800 border border-dark-600 rounded-lg text-xs text-dark-300">
                    {getActionIcon(message.action)}
                    <span>{formatAction(message.action)}</span>
                  </div>
                )}

                {/* Screenshot thumbnail */}
                {message.screenshot && (
                  <div className="mt-2 group relative inline-block">
                    <img
                      src={`data:image/png;base64,${message.screenshot}`}
                      alt="Screenshot"
                      onClick={() => openScreenshot(message.screenshot!, message.action?.arguments?.coordinate)}
                      className="max-w-[200px] rounded-lg border border-dark-600 opacity-75 hover:opacity-100 transition-opacity cursor-pointer"
                    />
                    <CrosshairMarker coordinate={message.action?.arguments?.coordinate} />
                    <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity">
                      <div className="bg-black/50 p-2 rounded-full backdrop-blur-sm">
                        <ZoomIn className="w-5 h-5 text-white" />
                      </div>
                    </div>
                  </div>
                )}

                {/* Zoom-refine crop the second pass looked at, with the
                    crop-local click (descale #1 of 2) marked on it. */}
                {message.zoomCrop && (
                  <div className="mt-2 group relative inline-block">
                    <img
                      src={`data:image/png;base64,${message.zoomCrop}`}
                      alt="Zoom crop"
                      onClick={() => openScreenshot(message.zoomCrop!, message.zoomCropCoordinate, message.zoomCropBox)}
                      className="max-w-[200px] rounded-lg border border-primary-700/60 opacity-75 hover:opacity-100 transition-opacity cursor-pointer"
                    />
                    <BoxMarker box={message.zoomCropBox} />
                    <CrosshairMarker coordinate={message.zoomCropCoordinate} />
                    <span className="absolute top-1 left-1 px-1.5 py-0.5 text-[10px] font-medium rounded bg-primary-500/80 text-white pointer-events-none">
                      {message.zoomCropCoordinate && message.zoomCropCoordinate.length >= 2
                        ? 'Zoom pass'
                        : 'Zoom pass · no click'}
                    </span>
                  </div>
                )}

                {/* Timestamp */}
                <p className="text-xs text-dark-600 mt-1">
                  {message.timestamp.toLocaleTimeString()}
                </p>
              </div>
            </>
          )}
        </div>
      ))}
      {/* Scroll anchor */}
      <div ref={messagesEndRef} />

      {/* Expanded Screenshot Modal. The calibration probe (click-to-measure)
          is a developer instrument, shown only when Debug Mode is on. */}
      {expandedScreenshot && (() => {
        const predicted = expandedScreenshot.coordinate;
        const hasPredicted = !!predicted && predicted.length >= 2;
        const pct = (v: number) => ((v / COORDINATE_BASE) * 100).toFixed(1);
        const delta =
          hasPredicted && groundTruth
            ? [groundTruth[0] - predicted![0], groundTruth[1] - predicted![1]]
            : null;
        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-8"
            onClick={() => setExpandedScreenshot(null)}
          >
            <button
              onClick={() => setExpandedScreenshot(null)}
              className="absolute top-4 right-4 p-2 text-white/70 hover:text-white transition-colors"
            >
              <X className="w-8 h-8" />
            </button>
            <div className="flex items-start gap-4 max-w-full max-h-full" onClick={(e) => e.stopPropagation()}>
              {/* Image with markers */}
              <div className="relative inline-block leading-none shrink-0">
                <img
                  src={`data:image/png;base64,${expandedScreenshot.screenshot}`}
                  alt="Expanded Screenshot"
                  onClick={debugMode ? handleProbeClick : undefined}
                  className={`block max-w-[70vw] max-h-[85vh] rounded-lg shadow-2xl border border-dark-700 ${debugMode ? 'cursor-crosshair' : ''}`}
                />
                <BoxMarker box={expandedScreenshot.box} />
                <CrosshairMarker coordinate={predicted} variant="predicted" />
                {debugMode && groundTruth && <CrosshairMarker coordinate={groundTruth} variant="target" />}
              </div>

              {/* Probe panel (debug only) */}
              {debugMode && (
              <div className="w-72 shrink-0 bg-dark-900 border border-dark-700 rounded-xl p-4 text-xs text-dark-200 space-y-3 max-h-[85vh] overflow-y-auto">
                <div className="flex items-center gap-2 text-sm font-medium text-white">
                  <Crosshair className="w-4 h-4 text-primary-400" />
                  Calibration probe
                </div>
                <p className="text-dark-400 leading-relaxed">
                  <span className="text-red-400">Red</span> = model prediction.
                  Click the true target to drop the <span className="text-cyan-400">cyan</span> marker, then record the pair.
                </p>

                <div className="space-y-1 font-mono">
                  <div className="flex justify-between">
                    <span className="text-red-400">predicted</span>
                    <span>{hasPredicted ? `${Math.round(predicted![0])}, ${Math.round(predicted![1])}` : '—'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-cyan-400">target</span>
                    <span>{groundTruth ? `${Math.round(groundTruth[0])}, ${Math.round(groundTruth[1])}` : 'click image'}</span>
                  </div>
                  <div className="flex justify-between border-t border-dark-700 pt-1">
                    <span className="text-dark-400">Δ norm</span>
                    <span>{delta ? `${delta[0] >= 0 ? '+' : ''}${Math.round(delta[0])}, ${delta[1] >= 0 ? '+' : ''}${Math.round(delta[1])}` : '—'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-dark-400">Δ %</span>
                    <span>{delta ? `${pct(delta[0])}%, ${pct(delta[1])}%` : '—'}</span>
                  </div>
                </div>

                <div className="flex gap-2">
                  <button
                    onClick={recordSample}
                    disabled={!hasPredicted || !groundTruth}
                    className="flex-1 px-3 py-1.5 rounded-lg bg-primary-500/20 text-primary-300 border border-primary-500/40 hover:bg-primary-500/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Record sample
                  </button>
                  <button
                    onClick={() => setSamples([])}
                    disabled={samples.length === 0}
                    className="px-3 py-1.5 rounded-lg bg-dark-700 text-dark-300 border border-dark-600 hover:bg-dark-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Clear
                  </button>
                </div>

                <div className="border-t border-dark-700 pt-2 space-y-1">
                  <div className="text-dark-400">Samples: <span className="text-white">{samples.length}</span></div>
                  {fitX && fitY ? (
                    <div className="space-y-1 font-mono text-[11px] leading-relaxed">
                      <div className="text-dark-400">Suggested correction (apply to model coords):</div>
                      <div>x' = x × {fitX.gain.toFixed(3)} {fitX.bias >= 0 ? '+' : '−'} {Math.abs(fitX.bias).toFixed(1)}</div>
                      <div>y' = y × {fitY.gain.toFixed(3)} {fitY.bias >= 0 ? '+' : '−'} {Math.abs(fitY.bias).toFixed(1)}</div>
                    </div>
                  ) : (
                    <div className="text-dark-500">Record ≥2 samples at different screen positions to fit a correction.</div>
                  )}
                </div>
              </div>
              )}
            </div>
          </div>
        );
      })()}
    </div>
  );
}
