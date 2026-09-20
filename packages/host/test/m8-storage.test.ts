import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkflowBuilder, compileWorkflow } from "@kouro/core";
import {
  Journal,
  crashMatrix,
  exportBackup,
  restoreBackup,
  verifyBackup,
} from "../src/storage/index.ts";

async function fixture() {
  const workflow = new WorkflowBuilder({ id: "m8-storage" });
  const done = workflow.complete("done");
  workflow.startAt(done);
  return compileWorkflow(workflow.build());
}

describe("M8 storage integrity and recovery diagnostics", () => {
  test("exports a consistent SQLite plus blob snapshot and verifies restored bytes", async () => {
    const root = mkdtempSync(join(tmpdir(), "kouro-m8-export-"));
    const journal = new Journal({ dataDir: join(root, "live") });
    const bundle = await fixture();
    const created = journal.createRun({ workflowId: "m8-storage", bundle, idempotencyKey: "run" });
    const blob = journal.blobs.put(
      created.run.runId,
      new TextEncoder().encode("retained artifact"),
      "text/plain",
    );
    journal.insertArtifact(blob);
    const backup = join(root, "backup");
    const manifest = exportBackup(journal, backup);
    expect(manifest.blobs.map((item) => item.digest)).toContain(blob.digest);
    expect(verifyBackup(backup).database.sha256).toBe(manifest.database.sha256);
    const restored = join(root, "restored");
    restoreBackup(backup, restored);
    const reopened = new Journal({ dataDir: restored });
    expect(reopened.getRunSummary(created.run.runId)?.runId).toBe(created.run.runId);
    expect(new TextDecoder().decode(reopened.blobs.read(blob))).toBe("retained artifact");
    reopened.close();
    journal.close();
  });

  test("detects a corrupted blob before restore", async () => {
    const root = mkdtempSync(join(tmpdir(), "kouro-m8-corrupt-"));
    const journal = new Journal({ dataDir: join(root, "live") });
    const bundle = await fixture();
    const created = journal.createRun({ workflowId: "m8-storage", bundle, idempotencyKey: "run" });
    const blob = journal.blobs.put(
      created.run.runId,
      new TextEncoder().encode("retained artifact"),
    );
    journal.insertArtifact(blob);
    const backup = join(root, "backup");
    exportBackup(journal, backup);
    const path = join(backup, "blobs", blob.digest.slice(0, 2), blob.digest);
    writeFileSync(path, readFileSync(path).toString() + "corrupt");
    expect(() => verifyBackup(backup)).toThrow(/blob checksum mismatch/);
    journal.close();
  });

  test("excludes artifacts committed after the SQLite snapshot", async () => {
    const root = mkdtempSync(join(tmpdir(), "kouro-m8-concurrent-"));
    const journal = new Journal({ dataDir: join(root, "live") });
    const bundle = await fixture();
    const created = journal.createRun({ workflowId: "m8-storage", bundle, idempotencyKey: "run" });
    const retained = journal.blobs.put(created.run.runId, new TextEncoder().encode("before"));
    journal.insertArtifact(retained);
    let laterDigest = "";
    const backup = join(root, "backup");
    const manifest = exportBackup(journal, backup, {
      onSnapshotReady: () => {
        const later = journal.blobs.put(created.run.runId, new TextEncoder().encode("after"));
        laterDigest = later.digest;
        journal.insertArtifact(later);
      },
    });
    expect(manifest.blobs.map((blob) => blob.digest)).toEqual([retained.digest]);
    expect(manifest.blobs.some((blob) => blob.digest === laterDigest)).toBe(false);
    const restored = join(root, "restored");
    restoreBackup(backup, restored);
    const reopened = new Journal({ dataDir: restored });
    expect(new TextDecoder().decode(reopened.blobs.read(retained))).toBe("before");
    expect(reopened.hasArtifactDigest(laterDigest)).toBe(false);
    reopened.close();
    journal.close();
  });

  test("rejects a manifest that omits a database-referenced blob", async () => {
    const root = mkdtempSync(join(tmpdir(), "kouro-m8-closure-"));
    const journal = new Journal({ dataDir: join(root, "live") });
    const bundle = await fixture();
    const created = journal.createRun({ workflowId: "m8-storage", bundle, idempotencyKey: "run" });
    journal.insertArtifact(journal.blobs.put(created.run.runId, new TextEncoder().encode("kept")));
    const backup = join(root, "backup");
    exportBackup(journal, backup);
    const manifestPath = join(backup, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { blobs: unknown[] };
    manifest.blobs = [];
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() => verifyBackup(backup)).toThrow(/artifact closure/);
    journal.close();
  });

  test("keeps the recovery matrix explicit and non-replay-safe for external boundaries", () => {
    expect(crashMatrix).toHaveLength(6);
    expect(crashMatrix.find((item) => item.boundary === "command claim")?.replaySafe).toBe(false);
    expect(crashMatrix.find((item) => item.boundary === "experiment cell")?.replaySafe).toBe(true);
  });

  test("ordinary run listing reads one bounded page", async () => {
    const root = mkdtempSync(join(tmpdir(), "kouro-m8-page-"));
    const journal = new Journal({ dataDir: join(root, "live") });
    const bundle = await fixture();
    for (let index = 0; index < 12; index += 1)
      journal.createRun({ workflowId: "m8-storage", bundle, idempotencyKey: `run-${index}` });
    expect(journal.listRunsPage(5, 0)).toHaveLength(5);
    expect(journal.listRunsPage(5, 5)).toHaveLength(5);
    expect(journal.listRunsPage(5, 10)).toHaveLength(2);
    expect(() => journal.listRunsPage(101)).toThrow(/page bounds/);
    journal.close();
  });
});
