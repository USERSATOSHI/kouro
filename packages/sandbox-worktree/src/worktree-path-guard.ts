import { access, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import { fromAsync, type Result } from '@usersatoshi/results';

import { SandboxErrorKind, type SandboxError, toErr } from './errors.ts';

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : 'Path guard failed';
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

async function nearestExistingParent(path: string): Promise<string> {
  let candidate = path;
  while (true) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      const parent = dirname(candidate);
      if (parent === candidate) throw new Error(`No existing parent for ${path}`);
      candidate = parent;
    }
  }
}

/** Guards direct provider file-tool paths against lexical and symbolic-link escapes. */
export class WorktreePathGuard {
  async guard(
    root: string,
    path: string,
    operation: 'read' | 'write',
  ): Promise<Result<string, SandboxError>> {
    return fromAsync(
      async () => {
        const canonicalRoot = await realpath(root);
        // Resolve absolute caller paths before canonicalizing the existing
        // target. On macOS `/var` is commonly a symlink to `/private/var`, so
        // comparing the caller's lexical spelling with the canonical root
        // would reject an otherwise valid path inside the worktree.
        const lexical = isAbsolute(path) ? resolve(path) : resolve(canonicalRoot, path);
        const existing = operation === 'read' ? lexical : await nearestExistingParent(lexical);
        const canonicalExisting = await realpath(existing);
        if (!isWithin(canonicalRoot, canonicalExisting)) {
          throw new Error('Path escapes the worktree through a symbolic link');
        }
        return lexical;
      },
      (error) =>
        toErr(SandboxErrorKind.BoundaryViolation, {
          operation,
          root,
          path,
          reason: messageFor(error),
        }),
    );
  }
}
