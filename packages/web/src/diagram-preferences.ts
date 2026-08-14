export type DiagramMode = 'flowchart' | 'timeline';

/** Migrates removed or unknown diagram modes to the useful flowchart view. */
export function diagramModeForStoredValue(value: string | null): DiagramMode {
  return value === 'timeline' ? 'timeline' : 'flowchart';
}
