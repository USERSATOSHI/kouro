import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Local CLI stand-in for acceptance tests; it never contacts a provider. */
export async function prepareSwarmProviderFixture(directory: string): Promise<string> {
  const executable = join(directory, "swarm-provider-fixture");
  await writeFile(
    executable,
    `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes("--version") || args.includes("--help")) {
  console.log("swarm fixture 1");
  process.exit(0);
}
const model = args[args.indexOf("--model") + 1];
const prompt = args.at(-1);
const context = JSON.parse(prompt.split("[KOURO_CONTEXT_BEGIN]\\n")[1].split("\\n[KOURO_CONTEXT_END]")[0]);
const values = Object.fromEntries(context.segments.filter(item => item.source === "artifact-input").map(item => [item.id.split(":").at(-1), JSON.parse(item.content)]));
console.log(JSON.stringify({ type: "text", part: { text: "Fixture model " + model + " started" } }));
await Bun.sleep(model === "slow" ? 30000 : model === "first" ? 350 : 50);
if (model === "fail") process.exit(1);
const summary = prompt.includes("Produce the final answer")
  ? Object.keys(values).filter(key => key.startsWith("member")).sort().map(key => key + ": " + values[key].summary).join("\\n")
  : model + ": " + values.task;
console.log(JSON.stringify({ summary }));
`,
  );
  await chmod(executable, 0o755);
  return executable;
}
