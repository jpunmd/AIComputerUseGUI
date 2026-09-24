import { AlertTriangle, Check, StopCircle, X } from 'lucide-react';
import type { ConfirmationRequest } from '../hooks/useAgent';

export function ActionConfirmation({
  request,
  onStop,
}: {
  request: ConfirmationRequest;
  onStop: () => void;
}) {
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="approval-title"
        className="bg-dark-900 border border-dark-700 rounded-2xl shadow-2xl max-w-xl w-full max-h-[95vh] overflow-y-auto"
      >
        <div className="flex items-center gap-3 px-6 py-4 bg-yellow-500/10 border-b border-yellow-500/30">
          <AlertTriangle className="w-5 h-5 text-yellow-400" />
          <h3
            id="approval-title"
            className="text-lg font-semibold text-yellow-400"
          >
            Confirmation required
          </h3>
        </div>
        <div className="px-6 py-5 space-y-3">
          <p className="text-dark-200 leading-relaxed whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
            {request.message}
          </p>
          {request.preview && (
            <figure>
              <div className="relative w-fit mx-auto leading-none">
                <img
                  src={`data:image/png;base64,${request.preview.image}`}
                  alt="Proposed click target"
                  className="max-w-full max-h-60 rounded-lg"
                />
                <span
                  aria-hidden="true"
                  className="absolute w-5 h-5 rounded-full border-2 border-red-400 -translate-x-1/2 -translate-y-1/2 pointer-events-none shadow-[0_0_0_1px_black]"
                  style={{
                    left: `${request.preview.coordinate[0] / 10}%`,
                    top: `${request.preview.coordinate[1] / 10}%`,
                  }}
                />
              </div>
              <figcaption className="mt-2 text-xs text-dark-400 text-center">
                Red circle shows the proposed click.
              </figcaption>
            </figure>
          )}
        </div>
        <div className="flex flex-col gap-2 px-6 py-4 bg-dark-800/50 border-t border-dark-700">
          {request.onAllowTask && (
            <>
              <button
                onClick={request.onAllowTask}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg bg-primary-600 hover:bg-primary-500 text-white font-medium"
              >
                <Check className="w-4 h-4" />
                Allow for this task
              </button>
              <p className="text-xs text-dark-400 mb-2">
                Allow this action and the remaining mouse and keyboard actions
                until this run ends. You can stop at any time.
              </p>
            </>
          )}
          <div className="flex gap-3">
            <button
              onClick={request.onDeny}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-dark-700 hover:bg-dark-600 text-dark-300 border border-dark-600"
            >
              <X className="w-4 h-4" />
              Reject
            </button>
            <button
              onClick={request.onConfirm}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-green-600 hover:bg-green-500 text-white"
            >
              <Check className="w-4 h-4" />
              Allow once
            </button>
          </div>
          <button
            onClick={onStop}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-dark-700/60 hover:bg-dark-700 text-dark-300 text-sm border border-dark-600"
          >
            <StopCircle className="w-3.5 h-3.5" />
            Stop task (Ctrl+Alt+F12)
          </button>
        </div>
      </div>
    </div>
  );
}
