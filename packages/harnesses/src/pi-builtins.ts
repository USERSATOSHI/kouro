import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { InlineExtension } from '@earendil-works/pi-coding-agent';

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isInlineExtension(value: unknown): value is InlineExtension {
  if (typeof value === 'function') return true;
  return isRecord(value) && typeof value.name === 'string' && typeof value.factory === 'function';
}

/**
 * Loads Pi's built-in extension factories for SDK consumers.
 *
 * Pi's CLI passes these factories to `DefaultResourceLoader`, while the public
 * SDK leaves that composition to its caller. The package currently keeps the
 * built-in list in an internal module, so resolve it from the installed package
 * entrypoint instead of depending on a workspace-specific node_modules path.
 */
export async function loadPiBuiltInExtensions(): Promise<InlineExtension[]> {
  const packageEntry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
  const modulePath = resolve(dirname(packageEntry), 'extensions/index.js');
  const loaded: unknown = await import(modulePath);
  if (!isRecord(loaded) || !Array.isArray(loaded.builtInExtensions)) {
    throw new Error('Pi built-in extensions are unavailable in the installed SDK');
  }

  const extensions: InlineExtension[] = [];
  for (const extension of loaded.builtInExtensions) {
    if (isInlineExtension(extension)) extensions.push(extension);
  }
  if (extensions.length === 0) {
    throw new Error('Pi installed no built-in extensions');
  }
  return extensions;
}
