import { CAPABILITY, RECOVERY_POLICY, WorkflowBuilder } from '@kouro/adw';

const workflow = new WorkflowBuilder({
  id: '{{id}}',
  version: '1.0.0',
})
  .permissions(CAPABILITY.REPOSITORY_READ, CAPABILITY.REPOSITORY_WRITE, CAPABILITY.TERMINAL_EXECUTE)
  .runLimits({
    maxDurationMs: 8 * 60 * 60 * 1000, // 8 hours
  });
const reviewRepairs = workflow.counter('reviewRepairs', 3);
const deliveryRepairs = workflow.counter('deliveryRepairs', 3);
const lintRepairs = workflow.counter('lintRepairs', 3);
const formatRepairs = workflow.counter('formatRepairs', 3);
const typecheckRepairs = workflow.counter('typecheckRepairs', 3);
const testRepairs = workflow.counter('testRepairs', 3);

const repositoryScout = workflow.subagent('repositoryScout', {
  role: 'repository-scout',
  prompt: './prompts/repository-scout.md',
  outputSchema: './schemas/scout.schema.ts',
  capabilities: [CAPABILITY.REPOSITORY_READ],
  maxInvocations: 2,
  maxConcurrent: 2,
});
const testScout = workflow.subagent('testScout', {
  role: 'test-scout',
  prompt: './prompts/test-scout.md',
  outputSchema: './schemas/scout.schema.ts',
  capabilities: [CAPABILITY.REPOSITORY_READ],
  maxInvocations: 2,
  maxConcurrent: 2,
});
const plan = workflow
  .agent('plan', {
    role: 'planner',
    prompt: './prompts/plan.md',
    capabilities: [CAPABILITY.REPOSITORY_READ],
    recoveryPolicy: RECOVERY_POLICY.RESUME_SUPPORTED,
  })
  .uses(repositoryScout, testScout);
const approval = workflow.approval('approval', {
  title: 'Approve feature implementation plan',
});
const implement = workflow.agent('implement', {
  role: 'implementer',
  prompt: './prompts/implement.md',
  capabilities: [
    CAPABILITY.REPOSITORY_READ,
    CAPABILITY.REPOSITORY_WRITE,
    CAPABILITY.TERMINAL_EXECUTE,
  ],
  recoveryPolicy: RECOVERY_POLICY.RESUME_SUPPORTED,
});
const lint = workflow.command('lint', {
  command: 'bun run lint',
  capabilities: [CAPABILITY.REPOSITORY_READ, CAPABILITY.TERMINAL_EXECUTE],
  recoveryPolicy: RECOVERY_POLICY.REPLAY_SAFE,
});
const format = workflow.command('format', {
  command: 'bun run format',
  capabilities: [CAPABILITY.REPOSITORY_READ, CAPABILITY.TERMINAL_EXECUTE],
  recoveryPolicy: RECOVERY_POLICY.REPLAY_SAFE,
});
const typecheck = workflow.command('typecheck', {
  command: 'bun run typecheck',
  capabilities: [CAPABILITY.REPOSITORY_READ, CAPABILITY.TERMINAL_EXECUTE],
  recoveryPolicy: RECOVERY_POLICY.REPLAY_SAFE,
});
const test = workflow.command('test', {
  command: 'bun test --pass-with-no-tests',
  capabilities: [CAPABILITY.REPOSITORY_READ, CAPABILITY.TERMINAL_EXECUTE],
  recoveryPolicy: RECOVERY_POLICY.REPLAY_SAFE,
});
const review = workflow.agent('review', {
  role: 'reviewer',
  prompt: './prompts/review.md',
  outputSchema: './schemas/delivery-metadata.schema.ts',
  capabilities: [CAPABILITY.REPOSITORY_READ],
  recoveryPolicy: RECOVERY_POLICY.RESUME_SUPPORTED,
});
implement.withContextFrom(plan, repositoryScout, testScout);
review.withContextFrom(plan, implement, repositoryScout, testScout);
const delivery = workflow.deliveryReview('delivery', {
  title: 'Review feature delivery',
  proposalFrom: 'review',
});
const complete = workflow.complete('complete');
const failed = workflow.complete('failed', { result: 'failed' });

workflow.startAt(plan);
plan.on('success').to(approval);
approval.on('approved').to(implement);
approval.on('rejected').to(failed);
implement.on('success').to(lint);
implement.on('failure').to(failed);
lint.on('success').to(format);
lint.on('failure').when(lintRepairs.belowLimit()).increment(lintRepairs).to(implement);
lint.on('failure').otherwise().to(failed);
format.on('success').to(typecheck);
format.on('failure').when(formatRepairs.belowLimit()).increment(formatRepairs).to(implement);
format.on('failure').otherwise().to(failed);
typecheck.on('success').to(test);
typecheck
  .on('failure')
  .when(typecheckRepairs.belowLimit())
  .increment(typecheckRepairs)
  .to(implement);
typecheck.on('failure').otherwise().to(failed);
test.on('success').to(review);
test.on('failure').when(testRepairs.belowLimit()).increment(testRepairs).to(implement);
test.on('failure').otherwise().to(failed);
review.on('success').to(delivery);
review.on('failure').when(reviewRepairs.belowLimit()).increment(reviewRepairs).to(implement);
review.on('failure').otherwise().to(failed);
delivery.on('approved').to(complete);
delivery
  .on('changes_requested')
  .when(deliveryRepairs.belowLimit())
  .increment(deliveryRepairs)
  .to(implement);
delivery.on('changes_requested').otherwise().to(failed);
delivery.on('rejected').to(failed);

export default workflow.build();
