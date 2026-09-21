import { WorkflowBuilder } from "@kouro/core";
import { Summary, Task } from "./schemas/schema.ts";

const planPrompt = await Bun.file(new URL("./prompts/plan.md", import.meta.url)).text();
const implementPrompt = await Bun.file(new URL("./prompts/implement.md", import.meta.url)).text();
const workflow = new WorkflowBuilder({ id: "{{id}}", version: "1" });
const task = workflow.input("task", Task);
const plan = workflow.agent("plan", {
  role: "planner",
  prompt: planPrompt,
  input: { task },
  produces: Summary,
});
const approval = workflow.approval("approve-plan", {
  action: "accept-plan",
  input: { task, plan: plan.output },
});
const implement = workflow.agent("implement", {
  role: "implementer",
  prompt: implementPrompt,
  input: { plan: plan.output },
});
const validate = workflow.command("validate", {
  executable: "/usr/bin/printf",
  args: ["Kouro M1 command\\n"],
});
const done = workflow.complete("done");
const failed = workflow.complete("failed", { result: "failed" });
workflow.startAt(plan);
plan.on("success").to(approval);
approval.on("approved").to(implement);
approval.on("rejected").to(failed);
workflow.sequence(implement, validate, done);
export default workflow.build();
