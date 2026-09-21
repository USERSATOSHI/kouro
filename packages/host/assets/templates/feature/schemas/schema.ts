import { artifactType } from "@kouro/core";
export const Task = artifactType<string>("kouro.workflow-task.v1", {
  type: "string",
  minLength: 1,
});
export const WorkItem = artifactType("kouro.work-item.v1", {
  type: "object",
  additionalProperties: false,
  required: ["version", "task"],
  properties: {
    version: { const: 1 },
    task: { type: "string", minLength: 1 },
    title: { type: "string" },
    description: { type: "string" },
    source: { type: "string" },
    ticket: { type: "object" },
  },
});
export const ScoutQuestion = artifactType<string>("kouro.scout-question.v1", {
  type: "string",
  minLength: 1,
});
export const ScoutReport = artifactType<{ summary: string; findings: string[] }>(
  "kouro.scout-report.v1",
  {
    type: "object",
    additionalProperties: false,
    required: ["summary", "findings"],
    properties: {
      summary: { type: "string", minLength: 1 },
      findings: { type: "array", items: { type: "string" } },
    },
  },
);
export const Summary = artifactType<{ summary: string; scoutReports?: unknown[] }>(
  "kouro.template-summary.v1",
  {
    type: "object",
    additionalProperties: false,
    required: ["summary"],
    properties: {
      summary: { type: "string", minLength: 1 },
      scoutReports: { type: "array" },
    },
  },
);
