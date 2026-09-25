import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { ActionResult, Message } from '../types';
import { BoxMarker, COORDINATE_BASE, CrosshairMarker } from './ScreenshotMarkers';
import { Bot, MousePointer, Keyboard, Move, Info, CheckCircle, AlertCircle, StopCircle, X, ZoomIn, ChevronRight, Crosshair, MessageSquare, HelpCircle, ListChecks, type LucideIcon } from 'lucide-react';

interface ChatHistoryProps {
  messages: Message[];
  expandThinkingByDefault?: boolean;
  debugMode?: boolean;
}

// The conversation renders as the user's prompts, each followed by a timeline
// of what the agent did: one card per model step, with system events between.
type Block =
  | { kind: 'user'; message: Message }
  | { kind: 'timeline'; messages: Message[] };

function groupMessages(messages: Message[]): Block[] {
  const blocks: Block[] = [];
  for (const message of messages) {
    const last = blocks[blocks.length - 1];
    if (message.role === 'user') blocks.push({ kind: 'user', message });
    else if (last?.kind === 'timeline') last.messages.push(message);
    else blocks.push({ kind: 'timeline', messages: [message] });
  }
  return blocks;
}

// Human-readable action summary, e.g. `Type "notepad"` or `Press ctrl+l`.
// Model-space coordinates are only meaningful when calibrating (debug mode).
export function describeAction(action: ActionResult, debugMode = false): string | null {
  const a = action.arguments ?? {};
  const quote = (s: string) => `“${s.length > 60 ? `${s.slice(0, 59)}…` : s}”`;
  let label: string;
  switch (action.action) {
    case 'none':
      return null;
    case 'click':
    case 'left_click':
      label = 'Click';
      break;
    case 'right_click':
      label = 'Right-click';
      break;
    case 'double_click':
      label = 'Double-click';
      break;
    case 'left_click_drag':
      label = 'Drag';
      break;
    case 'scroll':
      label = a.direction ? `Scroll ${a.direction}` : 'Scroll';
      break;
    case 'type':
      label = a.text ? `Type ${quote(a.text)}` : 'Type';
      break;
    case 'key':
      label = a.key ? `Press ${a.key}` : 'Press a key';
      break;
    case 'wait':
      label = 'Wait';
      break;
    case 'screenshot':
      label = 'Take a screenshot';
      break;
    case 'done':
      label = 'Finish task';
      break;
    case 'confirm':
      label = 'Ask for confirmation';
      break;
    case 'plan':
      label = 'Make a plan';
      break;
    default:
      label = (action.action || 'Action').replace(/_/g, ' ');
  }
  if (debugMode && a.coordinate && a.coordinate.length >= 2) {
    label += ` (${Math.round(a.coordinate[0])}, ${Math.round(a.coordinate[1])})`;
  }
  return label;
}

function actionIcon(action?: ActionResult): LucideIcon {
  switch (action?.action) {
    case 'click':
    case 'left_click':
    case 'right_click':
    case 'double_click':
      return MousePointer;
    case 'type':
    case 'key':
      return Keyboard;
    case 'scroll':
    case 'left_click_drag':
      return Move;
    case 'done':
      return CheckCircle;
    case 'confirm':
      return HelpCircle;
    case 'plan':
      return ListChecks;
    case 'none':
      return MessageSquare;
    default:
      return Bot;
  }
}

// System messages flag their tone with a leading symbol; the icon shows it,
// so the symbol itself is dropped from the text.
const SYSTEM_TONES = {
  success: { prefix: '✓', icon: CheckCircle, color: 'text-success' },
  warning: { prefix: '⚠', icon: AlertCircle, color: 'text-warning' },
  stopped: { prefix: '⏹', icon: StopCircle, color: 'text-danger' },
  info: { prefix: '', icon: Info, color: 'text-ink-400' },
} as const;

function systemTone(content: string): keyof typeof SYSTEM_TONES {
  if (content.startsWith('✓')) return 'success';
  if (content.startsWith('⚠')) return 'warning';
  if (content.startsWith('⏹')) return 'stopped';
  return 'info';
}

function stripTonePrefix(content: string) {
  const { prefix } = SYSTEM_TONES[systemTone(content)];
  return prefix ? content.slice(prefix.length).trimStart() : content;
}

function Thumbnail({
  image,
  alt,
  coordinate,
  box,
  badge,
  onOpen,
}: {
  image: string;
  alt: string;
  coordinate?: number[];
  box?: number[];
  badge?: string;
  onOpen: (image: string, coordinate?: number[], box?: number[]) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(image, coordinate, box)}
      className="group relative block w-full leading-none rounded-lg overflow-hidden border border-ink-700 hover:border-primary-500 transition-colors"
      title="Enlarge"
    >
      <img src={`data:image/png;base64,${image}`} alt={alt} className="block w-full" />
      <BoxMarker box={box} />
      <CrosshairMarker coordinate={coordinate} />
      {badge && (
        <span className="absolute top-1 left-1 px-1.5 py-0.5 text-[10px] font-medium rounded bg-primary-500/90 text-white">
          {badge}
        </span>
      )}
      <span className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
        <span className="bg-black/50 p-1.5 rounded-full">
          <ZoomIn className="w-4 h-4 text-white" />
        </span>
      </span>
    </button>
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
      <div className="flex-1 flex items-center justify-center text-ink-500">
        <div className="text-center">
          <Bot className="w-12 h-12 mx-auto mb-4 opacity-50" />
          <p>No messages yet</p>
          <p className="text-sm mt-1">Enter a command to get started</p>
        </div>
      </div>
    );
  }

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

  const time = (message: Message) =>
    message.timestamp.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  const renderStep = (message: Message) => {
    const label = message.action ? describeAction(message.action, debugMode) : null;
    const Icon = actionIcon(message.action);
    const hasImages = !!(message.screenshot || message.zoomCrop);
    return (
      <li key={message.id} className="relative pl-10 pb-5">
        <span className="absolute left-0 top-2 w-7 h-7 rounded-full bg-primary-500/15 text-primary-400 ring-4 ring-ink-950 flex items-center justify-center">
          <Icon className="w-3.5 h-3.5" />
        </span>
        <article className="rounded-xl border border-ink-700 bg-ink-900 p-3.5">
          <header className="flex items-center gap-2 text-xs min-w-0">
            <span className="font-semibold text-primary-400 shrink-0">
              {message.stepNumber ? `Step ${message.stepNumber}` : 'Assistant'}
            </span>
            {label && (
              <>
                <span className="text-ink-500" aria-hidden="true">·</span>
                <span className="font-medium text-ink-200 truncate" title={label}>{label}</span>
              </>
            )}
            <time className="ml-auto pl-2 text-ink-500 shrink-0">{time(message)}</time>
          </header>
          <div className="flex gap-4 mt-2">
            <div className="flex-1 min-w-0">
              <p className="text-sm text-ink-100 whitespace-pre-wrap break-words">
                {cleanContent(message.content)}
              </p>
              {message.thinking && (
                <div className="mt-2">
                  <button
                    onClick={() => toggleThinking(message.id)}
                    aria-expanded={isThinkingExpanded(message.id)}
                    className="flex items-center gap-1 text-xs text-ink-400 hover:text-ink-100 transition-colors"
                  >
                    <ChevronRight
                      className={`w-3.5 h-3.5 transition-transform ${isThinkingExpanded(message.id) ? 'rotate-90' : ''}`}
                    />
                    Thinking
                  </button>
                  {isThinkingExpanded(message.id) && (
                    <div className="mt-1.5 ml-1.5 pl-3 border-l-2 border-ink-700 text-xs text-ink-400 whitespace-pre-wrap leading-relaxed max-h-72 overflow-y-auto">
                      {message.thinking}
                    </div>
                  )}
                </div>
              )}
            </div>
            {hasImages && (
              <div className="shrink-0 w-40 space-y-2">
                {message.screenshot && (
                  <Thumbnail
                    image={message.screenshot}
                    alt="Screenshot"
                    coordinate={message.action?.arguments?.coordinate}
                    box={message.screenshotBox}
                    onOpen={openScreenshot}
                  />
                )}
                {/* Zoom-refine crop the second pass looked at, with the
                    crop-local click (descale #1 of 2) marked on it. */}
                {message.zoomCrop && (
                  <Thumbnail
                    image={message.zoomCrop}
                    alt="Zoom crop"
                    coordinate={message.zoomCropCoordinate}
                    box={message.zoomCropBox}
                    onOpen={openScreenshot}
                    badge={
                      message.zoomCropCoordinate && message.zoomCropCoordinate.length >= 2
                        ? 'Zoom pass'
                        : 'Zoom pass · no click'
                    }
                  />
                )}
              </div>
            )}
          </div>
        </article>
      </li>
    );
  };

  const renderEvent = (message: Message) => {
    const tone = systemTone(message.content);
    const { icon: Icon, color } = SYSTEM_TONES[tone];
    return (
      <li key={message.id} className="relative pl-10 pb-5">
        <span className="absolute left-0 top-0 w-7 h-7 rounded-full bg-ink-950 flex items-center justify-center">
          <Icon className={`w-4 h-4 ${color}`} />
        </span>
        <div className="pt-1 text-sm text-ink-300 min-w-0">
          <p className="whitespace-pre-wrap break-words">{stripTonePrefix(message.content)}</p>
          {message.modelResponse && (
            <details className="mt-1">
              <summary className="cursor-pointer text-xs text-primary-400">View rejected model response</summary>
              <pre className="mt-2 p-2 rounded-lg bg-ink-900 border border-ink-700 max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs select-text">{message.modelResponse}</pre>
            </details>
          )}
        </div>
      </li>
    );
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-6 space-y-5">
        {groupMessages(messages).map((block) =>
          block.kind === 'user' ? (
            <div key={block.message.id} className="flex flex-col items-end">
              <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-br-md bg-primary-500/15 border border-primary-500/25 text-sm text-ink-50 whitespace-pre-wrap break-words">
                {block.message.content}
              </div>
              <time className="mt-1 text-xs text-ink-500">{time(block.message)}</time>
            </div>
          ) : (
            <ol key={block.messages[0].id} className="relative">
              {/* Timeline rail, drawn behind the step markers */}
              <span aria-hidden="true" className="absolute left-[13px] top-3 bottom-5 w-px bg-ink-700" />
              {block.messages.map((m) => (m.role === 'system' ? renderEvent(m) : renderStep(m)))}
            </ol>
          ),
        )}
        {/* Scroll anchor */}
        <div ref={messagesEndRef} />
      </div>

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
                  className={`block max-w-[70vw] max-h-[85vh] rounded-lg shadow-2xl border border-ink-700 ${debugMode ? 'cursor-crosshair' : ''}`}
                />
                <BoxMarker box={expandedScreenshot.box} />
                <CrosshairMarker coordinate={predicted} variant="predicted" />
                {debugMode && groundTruth && <CrosshairMarker coordinate={groundTruth} variant="target" />}
              </div>

              {/* Probe panel (debug only) */}
              {debugMode && (
              <div className="w-72 shrink-0 bg-ink-900 border border-ink-700 rounded-xl p-4 text-xs text-ink-200 space-y-3 max-h-[85vh] overflow-y-auto">
                <div className="flex items-center gap-2 text-sm font-medium text-ink-50">
                  <Crosshair className="w-4 h-4 text-primary-400" />
                  Calibration probe
                </div>
                <p className="text-ink-400 leading-relaxed">
                  <span className="text-danger">Red</span> = model prediction.
                  Click the true target to drop the <span className="text-cyan-400">cyan</span> marker, then record the pair.
                </p>

                <div className="space-y-1 font-mono">
                  <div className="flex justify-between">
                    <span className="text-danger">predicted</span>
                    <span>{hasPredicted ? `${Math.round(predicted![0])}, ${Math.round(predicted![1])}` : '—'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-cyan-400">target</span>
                    <span>{groundTruth ? `${Math.round(groundTruth[0])}, ${Math.round(groundTruth[1])}` : 'click image'}</span>
                  </div>
                  <div className="flex justify-between border-t border-ink-700 pt-1">
                    <span className="text-ink-400">Δ norm</span>
                    <span>{delta ? `${delta[0] >= 0 ? '+' : ''}${Math.round(delta[0])}, ${delta[1] >= 0 ? '+' : ''}${Math.round(delta[1])}` : '—'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-ink-400">Δ %</span>
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
                    className="px-3 py-1.5 rounded-lg bg-ink-700 text-ink-300 border border-ink-600 hover:bg-ink-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Clear
                  </button>
                </div>

                <div className="border-t border-ink-700 pt-2 space-y-1">
                  <div className="text-ink-400">Samples: <span className="text-ink-50">{samples.length}</span></div>
                  {fitX && fitY ? (
                    <div className="space-y-1 font-mono text-[11px] leading-relaxed">
                      <div className="text-ink-400">Suggested correction (apply to model coords):</div>
                      <div>x' = x × {fitX.gain.toFixed(3)} {fitX.bias >= 0 ? '+' : '−'} {Math.abs(fitX.bias).toFixed(1)}</div>
                      <div>y' = y × {fitY.gain.toFixed(3)} {fitY.bias >= 0 ? '+' : '−'} {Math.abs(fitY.bias).toFixed(1)}</div>
                    </div>
                  ) : (
                    <div className="text-ink-500">Record ≥2 samples at different screen positions to fit a correction.</div>
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
