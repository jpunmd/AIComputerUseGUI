// Overlays drawn on screenshots at the model's normalized coordinates. Colors
// are fixed (not themed) because they sit on top of arbitrary desktop images.

// The normalized coordinate space the model emits clicks in. 0..1000 is
// universal across the grounding models this app targets (Qwen3-VL, Gemma).
export const COORDINATE_BASE = 1000;

// A precise crosshair reticle, positioned over a screenshot at a normalized
// coordinate (0..COORDINATE_BASE). Positioning by percentage keeps it accurate
// at any rendered image size. `variant` selects the color: red = the model's
// predicted click, cyan = the user's ground-truth target (probe).
export function CrosshairMarker({
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

// A bounding box [x0,y0,x1,y1] (normalized 0..COORDINATE_BASE) drawn as a
// rectangle over a screenshot or zoom crop, so you can see whether the model
// boxed the glyph or swallowed the text label. Positioned by percentage like
// the crosshair, so it tracks the image at any rendered size.
export function BoxMarker({ box }: { box?: number[] }) {
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
