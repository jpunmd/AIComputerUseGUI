import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Loader2, Monitor, RefreshCw } from 'lucide-react';

// One connected display, as the Rust side reports it. `number` is the label
// shown in this picker and on the identify overlay.
export interface DisplayInfo {
  name: string; // Windows device name; what settings store
  friendly_name: string;
  number: number;
  x: number;
  y: number;
  width: number;
  height: number;
  primary: boolean;
}

// How long the identify overlay stays up (src-tauri/src/displays.rs).
const IDENTIFY_MS = 3000;
// Diagram size limits in CSS pixels; the layout keeps each display's shape.
const DIAGRAM_MAX_WIDTH = 288;
const DIAGRAM_MAX_HEIGHT = 112;

interface DisplayPickerProps {
  /** Saved choice: '' is the primary display, otherwise a device name. */
  value: string;
  onChange: (name: string) => void;
  /** A run is in progress: the choice applies to the next run, and the
   * identify overlay stays off so its numbers never reach a screenshot. */
  runActive: boolean;
}

/** The display a saved choice refers to ('' = primary), or undefined if none is connected. */
export function resolveDisplay(
  displays: DisplayInfo[],
  value: string,
): DisplayInfo | undefined {
  return value === ''
    ? displays.find((display) => display.primary)
    : displays.find((display) => display.name === value);
}

export function DisplayPicker({ value, onChange, runActive }: DisplayPickerProps) {
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [identifying, setIdentifying] = useState(false);
  const seqRef = useRef(0);
  const identifyTimer = useRef<ReturnType<typeof setTimeout>>();

  const refresh = useCallback(async () => {
    const seq = ++seqRef.current;
    try {
      const list = await invoke<DisplayInfo[]>('list_displays');
      if (seq !== seqRef.current) return;
      setDisplays(Array.isArray(list) ? list : []);
      setError(null);
    } catch (err) {
      if (seq !== seqRef.current) return;
      setDisplays([]);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (seq === seqRef.current) setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => () => clearTimeout(identifyTimer.current), []);

  const identify = async () => {
    setIdentifying(true);
    try {
      await invoke('identify_displays');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    identifyTimer.current = setTimeout(() => setIdentifying(false), IDENTIFY_MS + 500);
  };

  const selected = resolveDisplay(displays, value);
  const missing = loaded && !error && value !== '' && !selected;
  const locked = runActive;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-4">
        <label htmlFor="target-display" className="block text-sm font-medium text-ink-300">
          Display
        </label>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={locked}
            title="Look for displays that were connected or disconnected"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-ink-600 text-ink-300 hover:bg-ink-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </button>
          <button
            type="button"
            onClick={() => void identify()}
            disabled={locked || identifying || displays.length === 0}
            title={
              locked
                ? 'Finish or stop the run first, so the numbers never appear in its screenshots'
                : 'Show each display’s number on its own screen'
            }
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-primary-500 text-white hover:bg-primary-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {identifying ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Monitor className="w-3.5 h-3.5" />
            )}
            {identifying ? 'Showing numbers…' : 'Identify displays'}
          </button>
        </div>
      </div>

      {displays.length > 0 && (
        <DisplayDiagram
          displays={displays}
          selected={selected}
          disabled={locked}
          onSelect={(display) => onChange(display.name)}
        />
      )}

      <select
        id="target-display"
        value={value}
        disabled={locked || displays.length === 0}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-4 py-3 bg-ink-800 border border-ink-600 rounded-lg text-ink-50 focus:border-primary-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <option value="">
          {primaryLabel(displays)}
        </option>
        {displays.map((display) => (
          <option key={display.name} value={display.name}>
            {displayLabel(display)}
          </option>
        ))}
        {missing && <option value={value}>Not connected ({value})</option>}
      </select>

      {error && <p className="text-xs text-danger">Could not list displays: {error}</p>}
      {missing && (
        <p className="text-xs text-warning">
          The selected display is not connected. Runs stop with an error until you choose a connected display.
        </p>
      )}
      {!error && loaded && displays.length === 0 && (
        <p className="text-xs text-warning">No displays were found.</p>
      )}
      <p className="text-xs text-ink-500">
        The agent takes screenshots of and clicks on this display. Numbers match the diagram and the labels Identify shows on each screen. Put the target application on this display. A change applies to the next run.
      </p>
    </div>
  );
}

function primaryLabel(displays: DisplayInfo[]): string {
  const primary = displays.find((display) => display.primary);
  return primary
    ? `Primary display (default): Display ${primary.number}`
    : 'Primary display (default)';
}

function displayLabel(display: DisplayInfo): string {
  const size = `${display.width} × ${display.height}`;
  const name = display.friendly_name && display.friendly_name !== display.name
    ? `${display.friendly_name}, `
    : '';
  return `Display ${display.number}: ${name}${size}${display.primary ? ' (primary)' : ''}`;
}

/** Each display drawn at its real position and relative size, numbered like the labels. */
function DisplayDiagram({
  displays,
  selected,
  disabled,
  onSelect,
}: {
  displays: DisplayInfo[];
  selected: DisplayInfo | undefined;
  disabled: boolean;
  onSelect: (display: DisplayInfo) => void;
}) {
  const left = Math.min(...displays.map((d) => d.x));
  const top = Math.min(...displays.map((d) => d.y));
  const right = Math.max(...displays.map((d) => d.x + d.width));
  const bottom = Math.max(...displays.map((d) => d.y + d.height));
  const totalWidth = Math.max(1, right - left);
  const totalHeight = Math.max(1, bottom - top);
  const scale = Math.min(DIAGRAM_MAX_WIDTH / totalWidth, DIAGRAM_MAX_HEIGHT / totalHeight);
  const boxWidth = Math.round(totalWidth * scale);
  const boxHeight = Math.round(totalHeight * scale);

  return (
    <div className="space-y-2">
      <div
        className="relative mx-auto rounded-lg border border-ink-700 bg-ink-900"
        style={{ width: boxWidth, height: boxHeight }}
      >
        {displays.map((display) => {
          const isSelected = selected?.name === display.name;
          return (
            <button
              key={display.name}
              type="button"
              disabled={disabled}
              aria-pressed={isSelected}
              aria-label={displayLabel(display)}
              title={displayLabel(display)}
              onClick={() => onSelect(display)}
              className={`absolute flex flex-col items-center justify-center rounded-md border-2 text-xs font-semibold transition-colors disabled:cursor-not-allowed ${
                isSelected
                  ? 'border-primary-500 bg-primary-500/20 text-ink-50'
                  : 'border-ink-600 bg-ink-800 text-ink-400 hover:border-ink-500'
              }`}
              style={{
                left: Math.round((display.x - left) * scale),
                top: Math.round((display.y - top) * scale),
                width: Math.max(1, Math.round(display.width * scale) - 2),
                height: Math.max(1, Math.round(display.height * scale) - 2),
              }}
            >
              <span className="text-base leading-none">{display.number}</span>
              {display.primary && <span className="mt-1 text-[10px] font-normal">primary</span>}
            </button>
          );
        })}
      </div>
      <p className="text-center text-xs text-ink-400">
        {selected
          ? `Working on Display ${selected.number}${selected.friendly_name && selected.friendly_name !== selected.name ? ` (${selected.friendly_name})` : ''}: ${selected.width} × ${selected.height}`
          : 'Working on a display that is not connected'}
      </p>
    </div>
  );
}
