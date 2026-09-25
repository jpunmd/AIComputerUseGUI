import { useEffect, useRef } from 'react';
import { AlertTriangle, Check, StopCircle, X } from 'lucide-react';
import type { ConfirmationRequest } from '../hooks/useAgent';
import { CrosshairMarker } from './ScreenshotMarkers';

// Enter is ignored this long after a request appears, so a keypress meant for
// something else (or a held key) can't approve an action nobody has read.
export const ENTER_ARM_DELAY_MS = 400;

function Kbd({ children }: { children: string }) {
  return (
    <kbd
      aria-hidden="true"
      className="ml-1 px-1.5 py-0.5 rounded border border-current text-[10px] font-sans opacity-70"
    >
      {children}
    </kbd>
  );
}

export function ActionConfirmation({
  request,
  onStop,
}: {
  request: ConfirmationRequest;
  onStop: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Enter = Allow once, Esc = Reject. Focus moves into the dialog so Enter
  // can't land on a control underneath it (such as the composer's Stop).
  useEffect(() => {
    dialogRef.current?.focus();
    const armedAt = Date.now() + ENTER_ARM_DELAY_MS;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        request.onDeny();
        return;
      }
      if (e.key !== 'Enter' || e.repeat || Date.now() < armedAt) return;
      // A focused button, link, or field handles Enter itself — e.g. Enter on
      // a tabbed-to Reject must reject, not approve.
      const target = e.target;
      if (
        target instanceof Element &&
        target.closest('button, a, input, textarea, select, summary')
      )
        return;
      e.preventDefault();
      request.onConfirm();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [request]);

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="approval-title"
        className="bg-ink-900 border border-ink-700 rounded-2xl shadow-2xl max-w-xl w-full max-h-[95vh] overflow-y-auto outline-none"
      >
        <div className="flex items-center gap-3 px-6 py-4 bg-warning/10 border-b border-warning/30">
          <AlertTriangle className="w-5 h-5 text-warning" />
          <h3 id="approval-title" className="text-lg font-semibold text-warning">
            Confirmation required
          </h3>
        </div>
        <div className="px-6 py-5 space-y-3">
          <p className="text-ink-200 leading-relaxed whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
            {request.message}
          </p>
          {request.preview && (
            <figure>
              <div className="relative w-fit mx-auto leading-none">
                <img
                  src={`data:image/png;base64,${request.preview.image}`}
                  alt="Proposed click target"
                  className="max-w-full max-h-60 rounded-lg border border-ink-700"
                />
                <CrosshairMarker coordinate={request.preview.coordinate} />
              </div>
              <figcaption className="mt-2 text-xs text-ink-400 text-center">
                The red crosshair marks the proposed click.
              </figcaption>
            </figure>
          )}
        </div>
        <div className="flex flex-col gap-3 px-6 py-4 bg-ink-800/50 border-t border-ink-700">
          <div className="flex gap-3">
            <button
              onClick={request.onDeny}
              aria-keyshortcuts="Escape"
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-ink-800 hover:bg-ink-700 text-ink-200 border border-ink-600 transition-colors"
            >
              <X className="w-4 h-4" />
              Reject
              <Kbd>Esc</Kbd>
            </button>
            <button
              onClick={request.onConfirm}
              aria-keyshortcuts="Enter"
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-primary-600 hover:bg-primary-500 text-white font-medium transition-colors"
            >
              <Check className="w-4 h-4" />
              Allow once
              <Kbd>Enter</Kbd>
            </button>
          </div>
          {request.onAllowTask && (
            <div>
              <button
                onClick={request.onAllowTask}
                className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm text-ink-300 hover:text-ink-50 border border-ink-600 hover:bg-ink-700 transition-colors"
              >
                Allow for this task
              </button>
              <p className="mt-1.5 text-xs text-ink-400 text-center">
                Skips review for the remaining mouse and keyboard actions until
                this run ends. You can still stop at any time.
              </p>
            </div>
          )}
          <button
            onClick={onStop}
            className="self-center flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs text-danger hover:bg-danger/10 transition-colors"
          >
            <StopCircle className="w-3.5 h-3.5" />
            Stop task (Ctrl+Alt+F12)
          </button>
        </div>
      </div>
    </div>
  );
}
