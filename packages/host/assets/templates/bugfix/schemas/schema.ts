import { artifactType } from "@kouro/core";
export const Task = artifactType<string>("kouro.workflow-task.v1", {
  type: "string",
  minLength: 1,
});
export const Summary = artifactType<{ summary: string }>("kouro.template-summary.v1", {
  type: "object",
  additionalProperties: false,
  required: ["summary"],
  properties: { summary: { type: "string", minLength: 1 } },
});
