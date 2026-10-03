import { artifactType, CAPABILITY } from "@kouro/core";

const strings = { type: "array", items: { type: "string" }, minItems: 1 };
export const Task = artifactType<string>("task", { type: "string", minLength: 1 });
export const Evidence = artifactType<{
  summary: string;
  findings: string[];
  uncertainties: string[];
}>("evidence", {
  type: "object",
  additionalProperties: false,
  required: ["summary", "findings", "uncertainties"],
  properties: {
    summary: { type: "string", minLength: 1 },
    findings: strings,
    uncertainties: { type: "array", items: { type: "string" } },
  },
});
export const Plan = artifactType<{
  summary: string;
  steps: string[];
  acceptance: string[];
  evidence: string[];
  risks: string[];
}>("implementation-plan", {
  type: "object",
  additionalProperties: false,
  required: ["summary", "steps", "acceptance", "evidence", "risks"],
  properties: {
    summary: { type: "string", minLength: 1 },
    steps: strings,
    acceptance: strings,
    evidence: strings,
    risks: { type: "array", items: { type: "string" } },
  },
});
export const Change = artifactType<{
  summary: string;
  changedFiles: string[];
  remainingWork: string[];
}>("change-report", {
  type: "object",
  additionalProperties: false,
  required: ["summary", "changedFiles", "remainingWork"],
  properties: {
    summary: { type: "string", minLength: 1 },
    changedFiles: { type: "array", items: { type: "string" } },
    remainingWork: { type: "array", items: { type: "string" } },
  },
});
export const Research = artifactType<{
  summary: string;
  findings: string[];
  sources: string[];
  disagreements: string[];
  openQuestions: string[];
}>("research-report", {
  type: "object",
  additionalProperties: false,
  required: ["summary", "findings", "sources", "disagreements", "openQuestions"],
  properties: {
    summary: { type: "string", minLength: 1 },
    findings: strings,
    sources: { type: "array", items: { type: "string" } },
    disagreements: { type: "array", items: { type: "string" } },
    openQuestions: { type: "array", items: { type: "string" } },
  },
});

export const read = [CAPABILITY.REPOSITORY_READ] as const;
export const researchAccess = [CAPABILITY.REPOSITORY_READ, CAPABILITY.NETWORK_ACCESS] as const;
export const write = [CAPABILITY.REPOSITORY_READ, CAPABILITY.REPOSITORY_WRITE] as const;
export const validate = [CAPABILITY.REPOSITORY_READ, CAPABILITY.TERMINAL_EXECUTE] as const;
export const scoutPrompt = `Inspect the repository for the task and question. Read the applicable
  project instructions, relevant implementation, tests, and package scripts. Report file paths
  and concrete evidence, including missing coverage. Do not modify files or execute commands.
  Return JSON with summary, findings, and uncertainties. Do not invent evidence.`;
export const requestScout = `Before finalizing, invoke the declared repositoryScout tool with
  { subagentId: "repositoryScout", requestId: a unique string, input: { task, question } }.
  Ask a focused question about affected files, behavior, and validation commands. Await the result
  and use its evidence. A missing or failed report is not successful scouting.`;
