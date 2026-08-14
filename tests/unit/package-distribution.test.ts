import { describe, expect, test } from 'bun:test';

interface PackageManifest {
  readonly bin?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly files?: readonly string[];
  readonly private?: boolean;
  readonly version?: string;
}

async function packageManifest(path: string): Promise<PackageManifest> {
  const value: unknown = await Bun.file(path).json();
  if (typeof value !== 'object' || value === null) throw new Error(`Invalid manifest at ${path}`);
  return value;
}

describe('package distribution', () => {
  test('ships a thin root launcher backed by the public CLI package', async () => {
    const [manifest, cli] = await Promise.all([
      packageManifest('package.json'),
      packageManifest('packages/cli/package.json'),
    ]);

    expect(manifest.bin?.kouro).toBe('bin/kouro.ts');
    expect(manifest.dependencies?.['@kouro/cli']).toBe(cli.version);
    expect(manifest.files).toContain('bin');
    expect(manifest.files).not.toContain('packages/cli/dist');
  });

  test('publishes CLI source, workflow assets, and web assets separately', async () => {
    const [cli, evaluations, web] = await Promise.all([
      packageManifest('packages/cli/package.json'),
      packageManifest('packages/evaluations/package.json'),
      packageManifest('packages/web/package.json'),
    ]);

    expect(cli.private).not.toBe(true);
    expect(cli.dependencies?.['@kouro/web']).toBe(web.version);
    expect(cli.files).toEqual(expect.arrayContaining(['src', 'assets']));
    expect(evaluations.private).not.toBe(true);
    expect(evaluations.files).toContain('src');
    expect(web.private).not.toBe(true);
    expect(web.files).toContain('dist');
    expect(web.files).not.toContain('src');
  });
});
