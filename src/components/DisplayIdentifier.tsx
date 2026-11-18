import { useEffect } from 'react';

// The identify overlay is a separate, click-through window per display. It loads
// this same page with ?identify=... and draws only the number, so it never
// runs the app or calls Tauri commands.
export interface IdentifyParams {
  number: number;
  primary: boolean;
  width: number;
  height: number;
}

/** Parse the overlay's query string; null means this is the main app window. */
export function parseIdentify(search: string): IdentifyParams | null {
  const params = new URLSearchParams(search);
  const raw = params.get('identify');
  if (raw === null) return null;
  const number = Number.parseInt(raw, 10);
  if (!Number.isInteger(number) || number < 1) return null;
  const [width, height] = (params.get('size') ?? '').split('x').map(Number);
  return {
    number,
    primary: params.get('primary') === '1',
    width: Number.isFinite(width) && width > 0 ? width : 0,
    height: Number.isFinite(height) && height > 0 ? height : 0,
  };
}

export function DisplayIdentifier({ number, primary, width, height }: IdentifyParams) {
  useEffect(() => {
    // Let the desktop show through everywhere except the outline and the card.
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
  }, []);

  return (
    <div
      className="fixed inset-0"
      style={{ border: '12px solid rgba(201, 100, 66, 0.95)' }}
    >
      <div
        className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center rounded-3xl px-10 py-6 text-center"
        style={{ background: 'rgba(20, 20, 19, 0.88)', color: '#faf9f5' }}
      >
        <span
          className="font-bold leading-none"
          style={{ fontSize: 'min(40vh, 40vw)' }}
        >
          {number}
        </span>
        <span className="mt-3 text-2xl font-semibold">
          Display {number}
          {primary ? ' · primary' : ''}
        </span>
        {width > 0 && height > 0 && (
          <span className="mt-1 text-base opacity-80">
            {width} × {height}
          </span>
        )}
      </div>
    </div>
  );
}
