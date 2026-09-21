import { WorkflowBuilder } from "@kouro/core";
import { Summary, Task } from "./schemas/schema.ts";
const planPrompt = await Bun.file(new URL("./prompts/plan.md", import.meta.url)).text();
const changePrompt = await Bun.file(new URL("./prompts/change.md", import.meta.url)).text();
const workflow = new WorkflowBuilder({ id: "{{id}}", version: "1" });
const task = workflow.input("task", Task);
const plan = workflow.agent("plan", {
  role: "chore-planner",
  prompt: planPrompt,
  input: { task },
  produces: Summary,
});
const change = workflow.agent("change", {
  role: "chore-worker",
  prompt: changePrompt,
  input: { task, plan: plan.output },
});
const validate = workflow.command("validate", {
  executable: "/usr/bin/printf",
  args: ["Kouro M1 command\\n"],
});
const done = workflow.complete("done");
workflow.startAt(plan);
workflow.sequence(plan, change, validate, done);
export default workflow.build();
