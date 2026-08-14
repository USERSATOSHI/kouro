# `@kouro/adw` — Authoring SDK and deterministic compiler

`@kouro/adw` provides the class-based TypeScript SDK for authoring Agent
Development Workflows and the deterministic compiler that turns their plain
definitions into canonical, checksummed runtime bundles.

## Architecture

```text
WorkflowBuilder
  -> build(): WorkflowAuthoringDefinition (plain data)
  -> compileAdwPackage(directory) (manifest and resource loading)
  -> compileWorkflow(source) (pure validation and normalization)
  -> CompiledWorkflowArtifact (bundle, canonical JSON, checksum)
```

Only `WorkflowBuilder` owns mutable authoring state. Handles, expressions, the
built definition, compiler inputs, and compiled artifacts carry data; builder
instances never cross into the compiler or runtime.

## Authoring a workflow

```typescript
import {
  all,
  CAPABILITY,
  HARNESS,
  output,
  REASONING_EFFORT,
  RECOVERY_POLICY,
  WorkflowBuilder,
} from '@kouro/adw';

const workflow = new WorkflowBuilder({
  id: 'feature-development',
  version: '1.0.0',
});

workflow.permissions(
  CAPABILITY.REPOSITORY_READ,
  CAPABILITY.REPOSITORY_WRITE,
  CAPABILITY.TERMINAL_EXECUTE,
);
workflow.runLimits({
  maxDurationMs: 8 * 60 * 60 * 1000,
  maxNodeInvocations: 30,
});
workflow.subworkflow('validation', {
  package: '../shared-validation',
  version: '1.0.0',
});

const testRepairs = workflow.counter('testRepair', 3);
const reviewRepairs = workflow.counter('reviewRepair', 2);
const architectureScout = workflow.subagent('architectureScout', {
  role: 'architecture-scout',
  prompt: './prompts/architecture-scout.md',
  reasoningEffort: REASONING_EFFORT.LOW,
  capabilities: [CAPABILITY.REPOSITORY_READ],
  maxInvocations: 2,
  maxConcurrent: 2,
});
const testScout = workflow.subagent('testScout', {
  role: 'test-scout',
  prompt: './prompts/test-scout.md',
  capabilities: [CAPABILITY.REPOSITORY_READ],
  maxInvocations: 3,
  maxConcurrent: 1,
});
const plan = workflow.agent('plan', {
  role: 'planner',
  prompt: './prompts/plan.md',
  reasoningEffort: REASONING_EFFORT.HIGH,
  outputSchema: './schemas/plan.schema.ts',
  capabilities: [CAPABILITY.REPOSITORY_READ],
  recoveryPolicy: RECOVERY_POLICY.RESUME_SUPPORTED,
});
plan.uses(architectureScout, testScout);
const approval = workflow.approval('planApproval', {
  title: 'Approve implementation plan',
});
const implement = workflow.agent('implement', {
  role: 'implementer',
  prompt: './prompts/implement.md',
  reasoningEffort: REASONING_EFFORT.MEDIUM,
  capabilities: [CAPABILITY.REPOSITORY_READ, CAPABILITY.REPOSITORY_WRITE],
  recoveryPolicy: RECOVERY_POLICY.RESUME_SUPPORTED,
});
const validate = workflow.command('validate', {
  command: 'bun run lint && bun run format && bun test',
  capabilities: [CAPABILITY.REPOSITORY_READ, CAPABILITY.TERMINAL_EXECUTE],
  recoveryPolicy: RECOVERY_POLICY.REPLAY_SAFE,
});
const review = workflow.agent('review', {
  role: 'reviewer',
  prompt: './prompts/review.md',
  harness: HARNESS.CODEX,
  models: {
    [HARNESS.CODEX]: 'gpt-5.2-codex',
  },
  capabilities: [CAPABILITY.REPOSITORY_READ],
  recoveryPolicy: RECOVERY_POLICY.RESUME_SUPPORTED,
});
implement.withContextFrom(plan, architectureScout, testScout);
review.withContextFrom(plan, implement, architectureScout, testScout);
const delivery = workflow.deliveryReview('delivery', {
  title: 'Review exact delivery',
  proposalFrom: 'review',
});
const complete = workflow.complete('complete');
const failed = workflow.complete('failed', { result: 'failed' });

workflow.startAt(plan);
plan.on('success').to(approval);
approval.on('approved').to(implement);
approval.on('rejected').to(failed);
implement.on('success').to(validate);
validate.on('success').to(review);
validate
  .on('failure')
  .when(testRepairs.belowLimit())
  .increment(testRepairs)
  .to(implement);
validate.on('failure').when(testRepairs.atLimit()).to(failed);
review
  .on('success')
  .when(all(output('approved').equals(false), reviewRepairs.belowLimit()))
  .increment(reviewRepairs)
  .to(implement);
review
  .on('success')
  .when(all(output('approved').equals(false), reviewRepairs.atLimit()))
  .to(failed);
review.on('success').when(output('approved').equals(true)).to(delivery);
delivery.on('approved').to(complete);

export default workflow.build();
```

The five node declaration methods are `agent`, `approval`, `deliveryReview`,
`command`, and `complete`. The first four return transition-capable handles. A
complete-node handle has no `on` method, so terminal transitions are rejected
by TypeScript.

`subagent` declares a bounded child role rather than a graph node. Only an
agent handle has `uses(...subagents)`, and it accepts multiple definitions. A
parent may call each authorized role repeatedly or concurrently within that
definition's `maxInvocations` and `maxConcurrent` limits. Subagent handles
cannot be passed to `startAt`, transitions, or `uses` on command nodes.

Subagents initially support only `repository.read`. Their capabilities must
also be present in the workflow permissions and in every parent agent that
authorizes them. Children receive no subagent tool, so delegation is exactly
one level deep. Use ordinary graph nodes when a stage needs durable retries,
transitions, approvals, write/execute authority, or independent recovery.

`deliveryReview` is the only authoring boundary that asks Kouro to prepare and
commit a reviewed tree. `proposalFrom` must name an agent node. A workflow
without this node completes without Kouro creating a commit or branch.

Repeated invocations of one agent node preserve its harness session by default
and receive the durable source-node output as workflow feedback. Add
`clearContext: true` to an agent config to force a fresh session for every graph
invocation.

Set `harness: 'codex'` when a workflow intentionally pins an agent node to one
harness. If `harness` is omitted, Kouro uses the node-specific CLI route and
then the CLI's default `--harness` policy. A workflow pin is included in the
compiled checksum and does not inherit CLI fallbacks.

Use `models` to select a model for each harness that may execute the node.
Kouro resolves the entry after selecting the harness, so fallback harnesses can
use different provider-specific model identifiers. The map is included in the
compiled checksum. If the selected harness has no entry, the harness uses its
configured default.

Set `reasoningEffort` on an agent or subagent when that role needs a stable
reasoning depth. `REASONING_EFFORT.LOW`, `.MEDIUM`, and `.HIGH` are portable
across the built-in harnesses. A node-level value is included in the compiled
checksum and takes precedence over the run-level choice. When omitted, an
agent uses the run-level effort and a subagent inherits its parent's effective
effort; omitting both preserves the provider default.

The SDK exports `HARNESS`, `CAPABILITY`, and `RECOVERY_POLICY` constants so
workflow declarations receive autocomplete without repeating protocol strings.
Their corresponding `HarnessId`, `Capability`, and `RecoveryPolicy` types are
literal unions. `HarnessModelMap` and `HarnessCapabilityMap` document the
dependent authoring contracts. A node pinned with `harness` accepts a model
entry only for that harness; an unpinned node may declare entries for multiple
harnesses. OpenCode model IDs use its required `provider/model` syntax.

`startAt(handle)` assigns the single entry node. `build()` returns the existing
`WorkflowAuthoringDefinition`; it does not compile the workflow.

## Transitions and expressions

Transitions start from a non-terminal node handle:

```typescript
source.on('success').to(target);
source.on('failure').when(condition).to(repair);
source.on('failure').otherwise().to(failed);
source.on('failure').when(counter.belowLimit()).increment(counter).to(repair);
```

Expression helpers emit the existing versioned expression data:

- `output(...path).equals(value)`
- `counter.lessThan(value)` and `counter.atLeast(value)`
- `counter.belowLimit()` and `counter.atLimit()`
- `all(...expressions)`, `any(...expressions)`, and `not(expression)`

Conditions observe a counter before the selected transition increments it.
Every graph cycle still requires an effective compiler-validated bound.

## Fail-fast authoring errors

`WorkflowBuilder` throws `WorkflowAuthoringError` for local state mistakes:

- duplicate node or counter names;
- node or counter handles owned by another builder;
- assigning the entry more than once;
- beginning a transition without completing it with `to`;
- building without an entry.

Graph-wide rules such as reachability, cycle bounds, duplicate transition
identities, permission declarations, and node configuration remain in the
deterministic compiler.

## ADW package structure

```text
my-workflow/
  manifest.json
  kouro.adw.ts
  prompts/
    implement.md
  schemas/
    change.schema.ts
```

Example manifest:

```json
{
  "id": "my-workflow",
  "name": "My Workflow",
  "version": "1.0.0",
  "kouro": "0.1.0",
  "entrypoint": "kouro.adw.ts",
  "permissions": ["repository.read", "repository.write"]
}
```

The entrypoint must default-export the result of `workflow.build()`. Agent
prompt and schema paths are resolved relative to the package directory.
Subworkflow packages are recursively compiled with package-cycle and exact
version checks.

## Compilation

```typescript
import { compileAdwPackage } from '@kouro/adw';

const result = await compileAdwPackage('./path/to/my-workflow');
if (result.isOk()) {
  const { bundle, canonical, checksum } = result.unwrap();
}
```

`compileWorkflow(source)` compiles an already assembled
`WorkflowSourceBundle`. Once resources are loaded, compilation is pure.
Canonical object keys, nodes, transitions, capabilities, and permissions are
ordered deterministically, producing byte-identical JSON and SHA-256 checksums
for the same workflow.

Compiler failures use
`Result<CompiledWorkflowArtifact, CompilerError>` from
`@usersatoshi/results`. Stable numeric `CompilerErrorKind` values cover invalid
manifests, resources, nodes, transitions, expressions, limits, permissions,
and subworkflows.

## Exported API

| Export | Kind |
|---|---|
| `WorkflowBuilder` | Stateful authoring builder |
| `REASONING_EFFORT` | Portable per-agent reasoning-depth constants |
| `WorkflowAuthoringError`, `WorkflowAuthoringErrorKind` | Fail-fast authoring errors |
| `output`, `all`, `any`, `not` | Pure expression helpers |
| Node, subagent, counter, and transition handle types | Fluent authoring contracts |
| `compileWorkflow` | Pure workflow compiler |
| `compileAdwPackage` | ADW package and resource compiler |
| `COMPILER_VERSION`, `IR_VERSION`, `EXPRESSION_VERSION` | Format versions |
| `CompilerErrorKind`, `CompilerError`, `toErr`, `toCompilerError` | Compiler errors |
| `canonicalJson`, `sha256`, `compareCanonicalText` | Canonicalization helpers |
