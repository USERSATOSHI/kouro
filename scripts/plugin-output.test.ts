import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStore } from "../packages/host/src/storage/blob-store.ts";
import { readOutput } from "../plugins/kouro/skills/implement/scripts/read-output.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "kouro-plugin-output-"));
  directories.push(dir);
  const store = new BlobStore(dir);
  const output = { summary: "Canonical detailed spec\n\nAcceptance criteria retained." };
  const ref = store.put(
    "run-planning",
    new TextEncoder().encode(JSON.stringify(output)),
    "application/json",
  );
  const draft = store.put(
    "run-planning",
    new TextEncoder().encode('{"summary":"draft"}'),
    "application/json",
  );
  const complete = { nodeId: "done", scopeId: "root", status: "succeeded", output: [ref] };
  const view = {
    bundle: {
      rootDefinitionId: "planning",
      definitions: { planning: { nodes: [{ id: "done", kind: "complete", result: "succeeded" }] } },
    },
    state: {
      status: "succeeded",
      rootScopeId: "root",
      invocations: {
        complete,
        draft: { nodeId: "draft", scopeId: "root", status: "succeeded", output: [draft] },
        child: { ...complete, scopeId: "child", output: [draft] },
      },
    },
  };
  return { dir, store, ref, output, view };
}

test("plugin reader retrieves canonical root output instead of member and child drafts", async () => {
  const { dir, view, output } = await fixture();
  expect(await readOutput(view, dir)).toEqual(output);
});

test("plugin reader rejects pending runs and ambiguous root completions", async () => {
  const { dir, view } = await fixture();
  await expect(
    readOutput({ ...view, state: { ...view.state, status: "running" } }, dir),
  ).rejects.toThrow("has not succeeded");
  await expect(
    readOutput(
      {
        ...view,
        state: {
          ...view.state,
          invocations: { ...view.state.invocations, duplicate: view.state.invocations.complete },
        },
      },
      dir,
    ),
  ).rejects.toThrow("Expected one");
});

test("plugin reader rejects corrupt blobs and path traversal references", async () => {
  const { dir, view, store, ref } = await fixture();
  await writeFile(store.pathForDigest(ref.digest), '{"summary":"tampered"}');
  await expect(readOutput(view, dir)).rejects.toThrow("checksum mismatch");
  const traversal = {
    ...view,
    state: {
      ...view.state,
      invocations: {
        complete: {
          ...view.state.invocations.complete,
          output: [{ ...ref, digest: "../../../secrets" }],
        },
      },
    },
  };
  await expect(readOutput(traversal, dir)).rejects.toThrow("Invalid artifact digest");
});

test("packaged output reader runs as a standalone CLI without project dependencies", async () => {
  const { dir, view, output } = await fixture();
  const saved = join(dir, "inspection.json");
  await writeFile(saved, JSON.stringify(view));
  const child = Bun.spawn(
    [
      "bun",
      join(import.meta.dir, "../plugins/kouro/skills/implement/scripts/read-output.ts"),
      saved,
      dir,
    ],
    { cwd: dir, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stderr).toBe("");
  expect(exit).toBe(0);
  expect(JSON.parse(stdout)).toEqual(output);
});
