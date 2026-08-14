import { describe, expect, test } from 'bun:test';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { compileAdwPackage } from '@kouro/adw';

const featurePackage = resolve(import.meta.dir, '../fixtures/adws/feature');
const goldenBundle = resolve(import.meta.dir, '../fixtures/golden/feature-simulation.bundle.json');
const goldenChecksum = resolve(import.meta.dir, '../fixtures/golden/feature-simulation.sha256');

describe('M1 content-addressed TypeScript ADW compiler', () => {
  test('resolves a TypeScript ADW into a complete data-only bundle', async () => {
    const compiled = await compileAdwPackage(featurePackage);
    expect(compiled.isOk()).toBe(true);
    if (compiled.isErr()) return;

    expect(compiled.unwrap().bundle.prompts).toEqual({
      './prompts/plan.md':
        'Produce a structured implementation plan for the requested repository change.\n',
      './prompts/scout.md':
        'Inspect the repository and return concise findings for the delegated task.\n',
    });
    expect(compiled.unwrap().bundle.schemas?.['./schemas/plan.schema.ts']).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['summary', 'steps'],
      properties: {
        summary: { type: 'string' },
        steps: {
          type: 'array',
          items: { type: 'string' },
        },
      },
    });
    expect(compiled.unwrap().bundle.subworkflows?.validation?.checksum).toMatch(
      /^sha256:[a-f0-9]{64}$/,
    );
    expect(compiled.unwrap().bundle.subagents).toEqual([
      {
        id: 'scout',
        role: 'repository-scout',
        prompt: './prompts/scout.md',
        outputSchema: './schemas/scout.schema.ts',
        reasoningEffort: 'low',
        capabilities: ['repository.read'],
        maxInvocations: 2,
        maxConcurrent: 2,
      },
    ]);
    expect(compiled.unwrap().bundle.semanticVersions).toEqual({
      compiler: '0.4.0',
      ir: '4',
      expressions: '1',
    });
  });

  test('matches the checked-in canonical bytes and checksum', async () => {
    const [compiled, canonical, checksum] = await Promise.all([
      compileAdwPackage(featurePackage),
      readFile(goldenBundle, 'utf8'),
      readFile(goldenChecksum, 'utf8'),
    ]);
    expect(compiled.isOk()).toBe(true);
    if (compiled.isErr()) return;

    expect(`${compiled.unwrap().canonical}\n`).toBe(canonical);
    expect(`${compiled.unwrap().checksum}\n`).toBe(checksum);
  });

  test('recompiles byte-identically in the same process', async () => {
    const first = await compileAdwPackage(featurePackage);
    const second = await compileAdwPackage(featurePackage);
    expect(first.isOk()).toBe(true);
    expect(second.isOk()).toBe(true);
    if (first.isOk() && second.isOk()) {
      expect(first.unwrap().canonical).toBe(second.unwrap().canonical);
      expect(first.unwrap().checksum).toBe(second.unwrap().checksum);
    }
  });

  test('normalizes the legacy Kairo manifest field to Kouro metadata', async () => {
    const directory = await mkdtemp(resolve(import.meta.dir, '.kouro-legacy-manifest-'));
    try {
      await cp(resolve(featurePackage, '..'), directory, { recursive: true });
      const packageDirectory = resolve(directory, 'feature');
      const manifestPath = resolve(packageDirectory, 'manifest.json');
      const manifest = await readFile(manifestPath, 'utf8');
      await writeFile(manifestPath, manifest.replace('"kouro":', '"kairo":'));

      const compiled = await compileAdwPackage(packageDirectory);

      expect(compiled.isOk()).toBe(true);
      if (compiled.isOk()) {
        expect(compiled.unwrap().bundle.manifest.metadata).toEqual(
          expect.objectContaining({ kouro: '>=0.1.0' }),
        );
        expect(compiled.unwrap().bundle.manifest.metadata).not.toHaveProperty('kairo');
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
