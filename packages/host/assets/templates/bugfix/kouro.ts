import { WorkflowBuilder } from "@kouro/core";
import { Summary, Task } from "./schemas/schema.ts";
const reproducePrompt = await Bun.file(new URL("./prompts/reproduce.md", import.meta.url)).text();
const fixPrompt = await Bun.file(new URL("./prompts/fix.md", import.meta.url)).text();
const workflow = new WorkflowBuilder({ id: "{{id}}", version: "1" });
const task = workflow.input("task", Task);
const reproduce = workflow.agent("reproduce", {
  role: "bug-reproducer",
  prompt: reproducePrompt,
  input: { task },
  produces: Summary,
});
const fix = workflow.agent("fix", {
  role: "bug-fixer",
  prompt: fixPrompt,
  input: { task, reproduction: reproduce.output },
});
const regression = workflow.command("regression", {
  executable: "/usr/bin/printf",
  args: ["Kouro M1 command\\n"],
});
const done = workflow.complete("done");
workflow.startAt(reproduce);
workflow.sequence(reproduce, fix, regression, done);
export default workflow.build();
