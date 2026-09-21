import { WorkflowBuilder } from "@kouro/core";
import { Summary, Task } from "./schemas/schema.ts";
const triagePrompt = await Bun.file(new URL("./prompts/triage.md", import.meta.url)).text();
const patchPrompt = await Bun.file(new URL("./prompts/patch.md", import.meta.url)).text();
const workflow = new WorkflowBuilder({ id: "{{id}}", version: "1" });
const task = workflow.input("task", Task);
const triage = workflow.agent("triage", {
  role: "hotfix-triage",
  prompt: triagePrompt,
  input: { task },
  produces: Summary,
});
const patch = workflow.agent("patch", {
  role: "hotfix-worker",
  prompt: patchPrompt,
  input: { task, triage: triage.output },
});
const smoke = workflow.command("smoke", {
  executable: "/usr/bin/printf",
  args: ["Kouro M1 command\\n"],
});
const done = workflow.complete("done");
workflow.startAt(triage);
workflow.sequence(triage, patch, smoke, done);
export default workflow.build();
