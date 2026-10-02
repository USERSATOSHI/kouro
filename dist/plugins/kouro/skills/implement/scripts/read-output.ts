import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid inspection view or artifact reference");
  }
  return value as Record<string, unknown>;
}

/** Read canonical completion artifacts without acquiring the runtime's state lock. */
export async function readOutput(view: unknown, dataDir: string): Promise<unknown> {
  const saved = record(view);
  const state = record(saved.state);
  if (state.status !== "succeeded")
    throw new Error("Run has not succeeded; resolve its pending work first");
  const bundle = record(saved.bundle);
  if (typeof bundle.rootDefinitionId !== "string" || typeof state.rootScopeId !== "string") {
    throw new Error("Inspection view lacks root identity");
  }
  const definition = record(record(bundle.definitions)[bundle.rootDefinitionId]);
  if (!Array.isArray(definition.nodes)) throw new Error("Inspection view lacks root nodes");
  const completionIds = new Set(
    definition.nodes
      .map(record)
      .filter((node) => node.kind === "complete" && node.result === "succeeded")
      .map((node) => node.id),
  );
  const completions = Object.values(record(state.invocations))
    .map(record)
    .filter(
      (invocation) =>
        invocation.scopeId === state.rootScopeId &&
        invocation.status === "succeeded" &&
        completionIds.has(invocation.nodeId),
    );
  if (completions.length !== 1)
    throw new Error("Expected one successful root completion; refusing to choose a draft");
  const refs = completions[0]!.output;
  if (!Array.isArray(refs) || refs.length === 0)
    throw new Error("Completion has no output artifacts");
  const outputs = await Promise.all(
    refs.map(async (value: unknown) => {
      const ref = record(value);
      if (typeof ref.digest !== "string" || !/^[a-f0-9]{64}$/.test(ref.digest)) {
        throw new Error("Invalid artifact digest");
      }
      const bytes = await readFile(resolve(dataDir, "blobs", ref.digest.slice(0, 2), ref.digest));
      if (createHash("sha256").update(bytes).digest("hex") !== ref.digest) {
        throw new Error("Artifact checksum mismatch");
      }
      if (ref.byteLength !== undefined && ref.byteLength !== bytes.byteLength) {
        throw new Error("Artifact length mismatch");
      }
      try {
        return JSON.parse(bytes.toString("utf8")) as unknown;
      } catch {
        throw new Error("Completion artifact is not JSON; use its declared output reader");
      }
    }),
  );
  return outputs.length === 1 ? outputs[0] : outputs;
}

if (import.meta.main) {
  try {
    const [viewPath, dataDir, ...extra] = process.argv.slice(2);
    if (!viewPath || !dataDir || extra.length)
      throw new Error("Usage: bun read-output.ts INSPECTION.json DATA_DIR");
    const view: unknown = JSON.parse(await readFile(viewPath, "utf8"));
    process.stdout.write(`${JSON.stringify(await readOutput(view, dataDir), null, 2)}\n`);
  } catch (cause) {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
  }
}
