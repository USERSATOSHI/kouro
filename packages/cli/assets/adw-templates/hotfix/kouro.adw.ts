import { CAPABILITY, RECOVERY_POLICY, WorkflowBuilder } from '@kouro/adw';

const workflow = new WorkflowBuilder({
  id: '{{id}}',
  version: '1.0.0',
})
  .permissions(CAPABILITY.REPOSITORY_READ, CAPABILITY.REPOSITORY_WRITE, CAPABILITY.TERMINAL_EXECUTE)
  .runLimits({
    maxDurationMs: 2 * 60 * 60 * 1000,
    maxNodeInvocations: 55,
  });
const lintRepairs = workflow.counter('lintRepairs', 2);
const formatRepairs = workflow.counter('formatRepairs', 2);
const typecheckRepairs = workflow.counter('typecheckRepairs', 2);
const testRepairs = workflow.counter('testRepairs', 2);
const deliveryRepairs = workflow.counter('deliveryRepairs', 2);

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
const assess = workflow
  .agent('assess', {
    role: 'hotfix-assessor',
    prompt: './prompts/assess.md',
    capabilities: [CAPABILITY.REPOSITORY_READ],
    recoveryPolicy: RECOVERY_POLICY.RESUME_SUPPORTED,
  })
  .uses(repositoryScout, testScout);
const implement = workflow.agent('implement', {
  role: 'hotfix-implementer',
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
const deliveryMetadata = workflow.agent('deliveryMetadata', {
  role: 'delivery-metadata-proposer',
  prompt: './prompts/delivery.md',
  outputSchema: './schemas/delivery-metadata.schema.ts',
  capabilities: [CAPABILITY.REPOSITORY_READ],
  recoveryPolicy: RECOVERY_POLICY.RESUME_SUPPORTED,
});
implement.withContextFrom(assess, repositoryScout, testScout);
deliveryMetadata.withContextFrom(assess, implement, repositoryScout, testScout);
const delivery = workflow.deliveryReview('delivery', {
  title: 'Review hotfix delivery',
  proposalFrom: 'deliveryMetadata',
});
const complete = workflow.complete('complete');
const failed = workflow.complete('failed', { result: 'failed' });

workflow.startAt(assess);
assess.on('success').to(implement);
assess.on('failure').to(failed);
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
test.on('success').to(deliveryMetadata);
test.on('failure').when(testRepairs.belowLimit()).increment(testRepairs).to(implement);
test.on('failure').otherwise().to(failed);
deliveryMetadata.on('success').to(delivery);
deliveryMetadata.on('failure').to(failed);
delivery.on('approved').to(complete);
delivery
  .on('changes_requested')
  .when(deliveryRepairs.belowLimit())
  .increment(deliveryRepairs)
  .to(implement);
delivery.on('changes_requested').otherwise().to(failed);
delivery.on('rejected').to(failed);

export default workflow.build();
