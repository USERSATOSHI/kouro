import { describe, expect, test } from 'bun:test';

import { diagramModeForStoredValue } from '../../packages/web/src/diagram-preferences.ts';

describe('web diagram preferences', () => {
  test('keeps flow and timeline while migrating the removed graph view', () => {
    expect(diagramModeForStoredValue('flowchart')).toBe('flowchart');
    expect(diagramModeForStoredValue('timeline')).toBe('timeline');
    expect(diagramModeForStoredValue('graph')).toBe('flowchart');
    expect(diagramModeForStoredValue(null)).toBe('flowchart');
  });
});
