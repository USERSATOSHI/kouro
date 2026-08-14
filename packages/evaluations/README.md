# `@kouro/evaluations`

Repository-local, content-addressed evaluation datasets and deterministic rule
evaluators for Kouro durable runs.

Datasets are checked in beside the workflow and repository fixtures they
measure. Compilation validates the complete definition, canonicalizes source
ordering, and binds later evaluation to an exact checksum.

```typescript
import { compileEvaluationDataset, evaluateRun } from '@kouro/evaluations';

const dataset = compileEvaluationDataset({
  schemaVersion: '1',
  id: 'feature-regression',
  version: '1.0.0',
  cases: [
    {
      id: 'add-health-check',
      workItem: { title: 'Add a health-check endpoint' },
      expectations: [
        { type: 'run_status', value: 'succeeded' },
        { type: 'node_outcome', nodeId: 'test', outcome: 'success' },
        { type: 'max_invocations', value: 20 },
        { type: 'max_total_tokens', value: 200_000 },
      ],
    },
  ],
}).unwrap();

const report = evaluateRun(dataset, 'add-health-check', { state: durableRunState });
```

Evaluation is observational. Reports do not schedule nodes, mutate runs, grant
approvals, or publish delivery artifacts. Missing best-effort model usage makes
a token-budget check `unavailable` instead of passing on a partial count.

`createEvaluationRecord()` binds a report to the run ID, repository identity,
starting commit, workflow checksum, canonical configuration checksum, exact
dataset checksum and case, experiment ID, evaluator version, actor, and time.

The package declares the `EvaluationStore` port. The SQLite adapter persists
records, append-only annotations, and pairwise preferences with idempotent
writes. Repository JSON discovery is a filesystem adapter in `@kouro/api`, so
the compiler and evaluator remain pure.

Checked-in definitions live directly under `.kouro/evaluations/*.json`. The
local API and CLI expose dataset discovery, terminal-run evaluation, report
queries, annotations, and experiment preferences. Artifact-content rubrics and
model judges remain separate recovery-aware future effects.
