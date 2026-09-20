/** Row window for the timeline's durable invocation order. Only this slice enters the DOM. */
export function virtualRows(
  total: number,
  top: number,
  height: number,
  rowHeight: number,
  overscan = 8,
): { first: number; last: number } {
  if (total <= 0) return { first: 0, last: 0 };
  const first = Math.max(0, Math.floor(Math.max(0, top) / rowHeight) - overscan);
  const last = Math.min(
    total,
    Math.ceil((Math.max(0, top) + Math.max(0, height)) / rowHeight) + overscan,
  );
  return { first, last };
}
