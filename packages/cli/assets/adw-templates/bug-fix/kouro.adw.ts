import { CAPABILITY, RECOVERY_POLICY, WorkflowBuilder } from '@kouro/adw';

const workflow = new WorkflowBuilder({
  id: '{{id}}',
  version: '1.0.0',
})
  .permissions(CAPABILITY.REPOSITORY_READ, CAPABILITY.REPOSITORY_WRITE, CAPABILITY.TERMINAL_EXECUTE)
  .runLimits({
    maxDurationMs: 4 * 60 * 60 * 1000,
    maxNodeInvocations: 70,
  });
const lintRepairs = workflow.counter('lintRepairs', 3);
const formatRepairs = workflow.counter('formatRepairs', 3);
const typecheckRepairs = workflow.counter('typecheckRepairs', 3);
const testRepairs = workflow.counter('testRepairs', 3);
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
const reproduce = workflow
  .agent('reproduce', {
    role: 'bug-investigator',
    prompt: './prompts/reproduce.md',
    capabilities: [CAPABILITY.REPOSITORY_READ, CAPABILITY.TERMINAL_EXECUTE],
    recoveryPolicy: RECOVERY_POLICY.RESUME_SUPPORTED,
  })
  .uses(repositoryScout, testScout);
const fix = workflow.agent('fix', {
  role: 'bug-fixer',
  prompt: './prompts/fix.md',
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
fix.withContextFrom(reproduce, repositoryScout, testScout);
deliveryMetadata.withContextFrom(reproduce, fix, repositoryScout, testScout);
const delivery = workflow.deliveryReview('delivery', {
  title: 'Review bug-fix delivery',
  proposalFrom: 'deliveryMetadata',
});
const complete = workflow.complete('complete');
const failed = workflow.complete('failed', { result: 'failed' });

workflow.startAt(reproduce);
reproduce.on('success').to(fix);
reproduce.on('failure').to(failed);
fix.on('success').to(lint);
fix.on('failure').to(failed);
lint.on('success').to(format);
lint.on('failure').when(lintRepairs.belowLimit()).increment(lintRepairs).to(fix);
lint.on('failure').otherwise().to(failed);
format.on('success').to(typecheck);
format.on('failure').when(formatRepairs.belowLimit()).increment(formatRepairs).to(fix);
format.on('failure').otherwise().to(failed);
typecheck.on('success').to(test);
typecheck.on('failure').when(typecheckRepairs.belowLimit()).increment(typecheckRepairs).to(fix);
typecheck.on('failure').otherwise().to(failed);
test.on('success').to(deliveryMetadata);
test.on('failure').when(testRepairs.belowLimit()).increment(testRepairs).to(fix);
test.on('failure').otherwise().to(failed);
deliveryMetadata.on('success').to(delivery);
deliveryMetadata.on('failure').to(failed);
delivery.on('approved').to(complete);
delivery
  .on('changes_requested')
  .when(deliveryRepairs.belowLimit())
  .increment(deliveryRepairs)
  .to(fix);
delivery.on('changes_requested').otherwise().to(failed);
delivery.on('rejected').to(failed);

export default workflow.build();
