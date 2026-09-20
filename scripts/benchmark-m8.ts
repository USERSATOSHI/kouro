import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, cpus } from "node:os";
import { join } from "node:path";
import { WorkflowBuilder, compileWorkflow } from "@kouro/core";
import { Journal } from "../packages/host/src/storage/journal.ts";
import { virtualRows } from "../packages/web/src/data/virtualRows.ts";

function summary(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    medianMs: Number(sorted[Math.floor(sorted.length / 2)]!.toFixed(2)),
    p95Ms: Number(sorted[Math.ceil(sorted.length * 0.95) - 1]!.toFixed(2)),
  };
}

const builder = new WorkflowBuilder({
  id: "m8-500-node-benchmark",
  version: "1",
  limits: { maxInvocations: 1_000, maxAttempts: 1_000 },
});
const nodes = Array.from({ length: 499 }, (_, index) =>
  builder.command(`step-${index}`, { executable: "/usr/bin/true" }),
);
const done = builder.complete("done");
builder.startAt(nodes[0]!);
builder.sequence(...nodes, done);
const source = builder.build();
const compileSamples: number[] = [];
let bundle = await compileWorkflow(source);
for (let index = 0; index < 10; index += 1) {
  const start = performance.now();
  bundle = await compileWorkflow(source);
  compileSamples.push(performance.now() - start);
}

const root = mkdtempSync(join(tmpdir(), "kouro-m8-benchmark-"));
try {
  const journal = new Journal({ dataDir: root });
  const tiny = new WorkflowBuilder({ id: "m8-history-benchmark", version: "1" });
  const tinyDone = tiny.complete("done");
  tiny.startAt(tinyDone);
  const historyBundle = await compileWorkflow(tiny.build());
  const run = journal.createRun({
    workflowId: "m8-history-benchmark",
    bundle: historyBundle,
    idempotencyKey: "benchmark",
  });
  for (let index = 0; index < 10_000; index += 1)
    journal.append({ runId: run.run.runId, type: "run.detached", payload: {}, actor: "benchmark" });
  const readSamples: number[] = [];
  for (let index = 0; index < 100; index += 1) {
    const start = performance.now();
    const page = journal.getFrames(run.run.runId, index * 100, 100);
    if (page.length !== 100) throw new Error(`expected 100 frames, got ${page.length}`);
    readSamples.push(performance.now() - start);
  }
  const window = virtualRows(10_000, 190_000, 380, 38);
  process.stdout.write(
    JSON.stringify(
      {
        platform: process.platform,
        architecture: process.arch,
        cpus: cpus()[0]?.model,
        bun: Bun.version,
        nodes: Object.values(bundle.definitions).reduce(
          (count, definition) => count + definition.nodes.length,
          0,
        ),
        historyEvents: 10_000,
        compile: summary(compileSamples),
        pageRead100: summary(readSamples),
        virtualTimelineRows: window.last - window.first,
      },
      null,
      2,
    ) + "\n",
  );
  journal.close();
} finally {
  rmSync(root, { recursive: true, force: true });
}
