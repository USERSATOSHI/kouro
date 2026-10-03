import { resolve } from "node:path";
import { compileWorkflow, type WorkflowDefinitionSource } from "@kouro/core";
import { docsExamples } from "./docs-examples";

const root = resolve(import.meta.dir, "..");
export async function checkDocExamples() {
  for (const example of docsExamples) {
    const { default: source } = (await import(
      resolve(root, "docs/examples", `${example.id}.ts`)
    )) as { default: WorkflowDefinitionSource };
    const bundle = await compileWorkflow(source);
    if (source.id !== example.id)
      throw new Error(`Example manifest ID differs from builder ID: ${example.id}`);
    for (const file of example.files) {
      if (!(await Bun.file(resolve(root, "docs/examples", file)).exists()))
        throw new Error(`Missing example file: ${file}`);
    }
    console.log(`Checked ${example.id}: ${bundle.boundSummary.invocations} bounded invocations`);
  }
}
if (import.meta.main) await checkDocExamples();
