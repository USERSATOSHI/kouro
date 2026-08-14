import { CAPABILITY, RECOVERY_POLICY, WorkflowBuilder } from '@kouro/adw';

const workflow = new WorkflowBuilder({
  id: '{{id}}',
  version: '1.0.0',
})
  .permissions(CAPABILITY.REPOSITORY_READ, CAPABILITY.TERMINAL_EXECUTE)
  .runLimits({
    maxDurationMs: 18 * 60 * 60 * 1000, // 18 hours
    maxNodeInvocations: 400,
  });
const reportRepairs = workflow.counter('reportRepairs', 2);

const repositoryScout = workflow.subagent('repositoryScout', {
  role: 'repository-scout',
  prompt: './prompts/repository-scout.md',
  outputSchema: './schemas/scout.schema.ts',
  capabilities: [CAPABILITY.REPOSITORY_READ],
  maxInvocations: 3,
  maxConcurrent: 3,
});
const assess = workflow
  .agent('assess', {
    role: 'security-assessor',
    prompt: './prompts/assess.md',
    outputSchema: './schemas/assess.schema.ts',
    capabilities: [CAPABILITY.REPOSITORY_READ, CAPABILITY.TERMINAL_EXECUTE],
    recoveryPolicy: RECOVERY_POLICY.RESUME_SUPPORTED,
  })
  .uses(repositoryScout);
const analyze = workflow
  .agent('analyze', {
    role: 'security-analyst',
    prompt: './prompts/analyze.md',
    outputSchema: './schemas/findings.schema.ts',
    capabilities: [CAPABILITY.REPOSITORY_READ, CAPABILITY.TERMINAL_EXECUTE],
    recoveryPolicy: RECOVERY_POLICY.RESUME_SUPPORTED,
  })
  .uses(repositoryScout);
const report = workflow.agent('report', {
  role: 'security-reporter',
  prompt: './prompts/report.md',
  outputSchema: './schemas/report.schema.ts',
  capabilities: [CAPABILITY.REPOSITORY_READ],
  recoveryPolicy: RECOVERY_POLICY.RESUME_SUPPORTED,
});
analyze.withContextFrom(assess, repositoryScout);
report.withContextFrom(assess, analyze, repositoryScout);
const approval = workflow.approval('approval', {
  title: 'Review security audit report',
});
const complete = workflow.complete('complete');
const failed = workflow.complete('failed', { result: 'failed' });

workflow.startAt(assess);
assess.on('success').to(analyze);
assess.on('failure').to(failed);
analyze.on('success').to(report);
analyze.on('failure').to(failed);
report.on('success').to(approval);
report.on('failure').when(reportRepairs.belowLimit()).increment(reportRepairs).to(analyze);
report.on('failure').otherwise().to(failed);
approval.on('approved').to(complete);
approval.on('rejected').to(failed);

export default workflow.build();
