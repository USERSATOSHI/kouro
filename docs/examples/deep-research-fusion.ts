import { WorkflowBuilder } from "@kouro/core";
import { Task, Evidence, Research, researchAccess } from "./support.ts";

// Example task: compare PostgreSQL and SQLite for a local-first multi-process application.
// NETWORK_ACCESS enables native Codex live search and Claude WebSearch/WebFetch.
// Authenticate both harnesses and replace the model placeholders before running.
const workflow = new WorkflowBuilder({
  id: "deep-research-fusion",
  version: "1",
  limits: { maxRunDurationMs: 60 * 60 * 1000 },
});
const task = workflow.input("task", Task);
const researcherA = workflow.agent("researcher-a", {
  harness: "codex",
  modelId: "YOUR_CODEX_MODEL",
  prompt: `Investigate the research question using available search tools and supplied repository
    sources. Prefer primary documentation and research. Record source URLs, dates, concrete evidence,
    and tradeoffs. Distinguish fact, inference, and gaps. Never claim retrieval without a tool result.
    If no source was retrieved or supplied, leave sources empty and explain the limitation.
    Return JSON with summary, findings, sources, disagreements, openQuestions.`,
  produces: Research,
  capabilities: researchAccess,
});
const researcherB = workflow.agent("researcher-b", {
  harness: "claude",
  modelId: "YOUR_CLAUDE_MODEL",
  prompt: `Independently research the question with available search/fetch tools. Test competing
    explanations, seek counterexamples, verify dates, and compare source quality. Cite actual URLs.
    If a tool is unavailable, state the limitation rather than inventing retrieved evidence.
    Return JSON with summary, findings, sources, disagreements, openQuestions.`,
  produces: Research,
  capabilities: researchAccess,
});
const synthesis = workflow.agent("synthesis", {
  harness: "codex",
  modelId: "YOUR_CODEX_MODEL",
  prompt: `Write a decision-oriented research report from the revised findings and final critiques.
    Verify disputed source claims with available tools. Preserve citations and unresolved disagreements.
    State the conditions under which each recommendation holds and what still needs measurement.
    Return JSON with summary, findings, sources, disagreements, openQuestions.`,
  produces: Research,
  capabilities: researchAccess,
});
const research = workflow
  .fusion("research", {
    task,
    rounds: 2,
    reviewProduces: Evidence,
    reviewPrompt: `Audit the peer report's actual sources using available search/fetch tools. Check
    currency, causality, missing counterevidence, and whether conclusions follow from evidence.
    Return JSON with summary, findings, uncertainties; cite URLs in the findings.`,
    revisionPrompt: `Recheck sources and revise the report against all critiques. Preserve contradictory
    evidence and unanswered questions. Return JSON with summary, findings, sources, disagreements, openQuestions.`,
    synthesis,
  })
  .use(researcherA, researcherB);
workflow.startAt(research);
workflow.sequence(research, workflow.complete("done", { output: research.output }));
export default workflow.build();
