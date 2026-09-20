import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkspaceRef } from "../adapters/workspace/git.ts";
import { GitWorkspaceAdapter } from "../adapters/workspace/git.ts";

/** Small durable mark set used to serialize checkpoint retention and cleanup. */
export class CheckpointRetention {
  private readonly path: string;
  private readonly marks: Record<string, string[]>;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.path = join(dataDir, "checkpoint-retention.json");
    this.marks = existsSync(this.path)
      ? (JSON.parse(readFileSync(this.path, "utf8")) as Record<string, string[]>)
      : {};
  }

  retain(checkpointId: string, roots: readonly string[]): void {
    for (const root of roots)
      if (!/^[a-f0-9]{40,64}$/.test(root))
        throw new Error(`invalid retained content root: ${root}`);
    const existing = this.marks[checkpointId];
    if (existing && JSON.stringify(existing) !== JSON.stringify(roots))
      throw new Error("checkpoint retention roots are immutable");
    this.marks[checkpointId] = [...roots];
    this.flush();
  }

  /** Repair a crash between the SQLite certificate commit and the mark-file write. */
  reconcile(certificates: readonly { checkpointId: string; roots: readonly string[] }[]): void {
    let changed = false;
    for (const certificate of certificates) {
      for (const root of certificate.roots)
        if (!/^[a-f0-9]{40,64}$/.test(root))
          throw new Error(`invalid retained content root: ${root}`);
      const existing = this.marks[certificate.checkpointId];
      if (existing && JSON.stringify(existing) !== JSON.stringify(certificate.roots))
        throw new Error("checkpoint retention roots conflict with SQLite certificate");
      if (!existing) {
        this.marks[certificate.checkpointId] = [...certificate.roots];
        changed = true;
      }
    }
    if (changed) this.flush();
  }

  release(checkpointId: string): void {
    delete this.marks[checkpointId];
    this.flush();
  }

  isRetained(root: string): boolean {
    return Object.values(this.marks).some((roots) => roots.includes(root));
  }

  assertCleanupAllowed(roots: readonly string[]): void {
    if (roots.some((root) => this.isRetained(root)))
      throw new Error("refusing cleanup of checkpoint-retained root");
  }

  async cleanupWorkspace(
    adapter: GitWorkspaceAdapter,
    ref: WorkspaceRef,
    roots: readonly string[],
    options: { active?: boolean } = {},
  ): Promise<void> {
    this.assertCleanupAllowed(roots);
    await adapter.cleanup(ref, { ...options, retainedTreeRoots: this.allRoots() });
  }

  retainedRoots(): readonly string[] {
    return this.allRoots();
  }

  private allRoots(): string[] {
    return [...new Set(Object.values(this.marks).flat())];
  }

  private flush(): void {
    const temp = `${this.path}.tmp`;
    writeFileSync(temp, JSON.stringify(this.marks), { mode: 0o600 });
    renameSync(temp, this.path);
  }
}
