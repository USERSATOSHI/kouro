import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const registry = "https://git.usersatoshi.com/api/packages/kouro/npm/";
const packages = ["packages/core", "packages/host"] as const;

if (!process.env.KOURO_FORGEJO_TOKEN) {
  throw new Error("KOURO_FORGEJO_TOKEN is required");
}

for (const directory of packages) {
  const packageDirectory = resolve(root, directory);
  process.stdout.write(`Publishing ${directory} to ${registry}\n`);
  const child = Bun.spawn(
    [
      "bun",
      `--config=${resolve(root, "bunfig.publish-forgejo.toml")}`,
      "publish",
      "--registry",
      registry,
      "--tolerate-republish",
    ],
    {
      cwd: packageDirectory,
      env: { ...process.env, NPM_CONFIG_TOKEN: process.env.KOURO_FORGEJO_TOKEN },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`Publishing ${directory} failed with exit code ${exitCode}`);
}
