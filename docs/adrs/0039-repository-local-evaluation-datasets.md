# ADR-0039: Evaluation datasets are repository-local, versioned inputs

- Status: Accepted
- Date: 2026-08-14

## Context

Kouro can compare durable run mechanics such as status, token usage, cost, and
per-role execution. It cannot yet state whether a workflow version performed
well against repeatable expectations. A completed workflow is not necessarily
a high-quality workflow, and nondeterministic model behavior makes ordinary
unit tests insufficient for comparing prompts, models, and workflow revisions.

Company-wide or team-wide memory is outside Kouro's boundary. Evaluation data
must not depend on Kyuki, mutable ambient memory, or a hosted tracing service.
It also must not grant evaluators authority to alter scheduling, approvals,
permissions, repository state, or delivery.

## Decision

Kouro evaluation datasets are checked-in, repository-local definitions. Each
dataset declares a schema version, stable ID, author-controlled version, and
uniquely identified cases. A case contains one immutable work item and an
ordered set of deterministic expectations.

Compilation validates the complete dataset, canonicalizes case and expectation
ordering, and produces a SHA-256 checksum. Experiments will bind to that exact
checksum rather than a mutable dataset name.

The first expectation language contains only rules observable from durable run
state:

- terminal run status;
- maximum invocation count;
- maximum reported token count;
- latest outcome of a declared node.

Each check produces `passed`, `failed`, or `unavailable`. Missing best-effort
usage makes a token-budget check unavailable instead of falsely passing.
Aggregate evaluation passes only when every check passes; unavailable evidence
produces an incomplete result.

Evaluator output is observational data. It cannot mutate a run or become an
approval implicitly. A future workflow may declare an evaluation gate, but
that requires separate compiled runtime semantics and another ADR.

## Consequences

- Datasets can be reviewed and versioned with the repository they evaluate.
- The same canonical dataset produces the same checksum independent of source
  declaration order.
- Rule evaluation is provider-neutral and requires no model call.
- Existing durable runs can be evaluated without replaying their side effects.
- ADR-0040 defines persisted experiment reports, human annotations, and
  pairwise preferences without changing this pure evaluator boundary.
- Automatic case-run launch, artifact evaluators, and model judges remain
  later slices.
- Current repository files and ADRs remain authoritative context; datasets
  measure behavior and do not act as cross-run agent memory.

## Alternatives considered

### Use Kyuki as the dataset or memory authority

Rejected because Kyuki is company/team-wide and is not an allowed dependency
for Kouro's repository-local evaluation feature.

### Store datasets only in Kouro's SQLite database

Rejected for the first version because dataset changes would be harder to
review with the workflow and repository fixtures they evaluate.

### Start with an LLM-as-judge

Deferred. Model judges add cost, nondeterminism, rubric versioning, and their
own recovery requirements. Deterministic and human evidence should establish
the evaluation boundary first.

### Let evaluator failures block delivery automatically

Rejected because it would introduce undeclared orchestration authority. Any
future gate must be explicit in the compiled workflow.
