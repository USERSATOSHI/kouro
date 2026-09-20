import { extent, ticks } from "d3-array";
import { scaleTime } from "d3-scale";

export interface TimelineScale {
  start: number;
  end: number;
  width: number;
  x: (time: number) => number;
  ticks: number[];
  tickFormat: (time: number) => string;
}

const formatElapsed = (ms: number, span: number) => {
  if (span < 60_000) return `${(ms / 1_000).toFixed(span < 10_000 ? 1 : 0)}s`;
  if (span < 3_600_000)
    return `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1_000)).padStart(2, "0")}`;
  return `${(ms / 3_600_000).toFixed(span < 21_600_000 ? 1 : 0)}h`;
};

/** An honest continuous time scale: the viewport width determines tick density. */
export const makeTimeScale = (start: number, end: number, width: number): TimelineScale => {
  const safeEnd = Math.max(start + 1, end);
  const safeWidth = Math.max(1, width);
  const scale = scaleTime<number>()
    .domain([new Date(start), new Date(safeEnd)])
    .range([0, safeWidth]);
  const tickCount = Math.max(2, Math.floor(safeWidth / 92));
  const values = ticks(start, safeEnd, tickCount);
  return {
    start,
    end: safeEnd,
    width: safeWidth,
    x: (time) => scale(new Date(time)),
    ticks: values.length ? values : [start, safeEnd],
    tickFormat: (time) => formatElapsed(time - start, safeEnd - start),
  };
};

export const spanBounds = (
  spans: Array<{ start?: number; end?: number; elapsed?: number }>,
  now = Date.now(),
) => {
  const values = spans.flatMap((span) => {
    const start = span.start ?? now;
    const end = span.end ?? (span.elapsed ? start + span.elapsed : now);
    return [start, end];
  });
  const [min, max] = extent(values);
  return { start: min ?? now - 1, end: Math.max(max ?? now, (min ?? now - 1) + 1) };
};
