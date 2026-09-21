import { WorkflowBuilder } from "@kouro/core";
import { Summary, Task } from "./schemas/schema.ts";
const inspectPrompt = await Bun.file(new URL("./prompts/inspect.md", import.meta.url)).text();
const changePrompt = await Bun.file(new URL("./prompts/change.md", import.meta.url)).text();
const workflow = new WorkflowBuilder({ id: "{{id}}", version: "1" });
const task = workflow.input("task", Task);
const inspect = workflow.agent("inspect", {
  role: "refactor-analyst",
  prompt: inspectPrompt,
  input: { task },
  produces: Summary,
});
const change = workflow.agent("change", {
  role: "refactor-worker",
  prompt: changePrompt,
  input: { task, plan: inspect.output },
});
const validate = workflow.command("validate", {
  executable: "/usr/bin/printf",
  args: ["Kouro M1 command\\n"],
});
const done = workflow.complete("done");
workflow.startAt(inspect);
workflow.sequence(inspect, change, validate, done);
export default workflow.build();
