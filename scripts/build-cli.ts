import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const dist = resolve(root, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const child = Bun.spawn(
  [
    "bun",
    "build",
    "packages/host/src/cli.ts",
    "--outfile",
    resolve(dist, "kouro.js"),
    "--target",
    "bun",
    "--external",
    "@anthropic-ai/claude-agent-sdk",
  ],
  { cwd: root, stdin: "inherit", stdout: "inherit", stderr: "inherit" },
);
const exitCode = await child.exited;
if (exitCode !== 0) throw new Error(`Building the bundled CLI failed with exit code ${exitCode}`);

await cp(resolve(root, "packages/host/assets"), resolve(dist, "assets"), { recursive: true });
await cp(resolve(root, "packages/web/dist"), resolve(dist, "web"), { recursive: true });
