# ADR-0040: Evaluation experiments persist observational and human evidence

- Status: Accepted
- Date: 2026-08-14

## Context

ADR-0039 defines repository-local, content-addressed evaluation datasets and
pure deterministic checks. Kouro also needs to apply an exact dataset case to
an existing durable run, retain the result, compare controlled variants, and
record human review without turning evaluation into orchestration authority.

Evaluation evidence crosses application, persistence, HTTP, CLI, and web
boundaries. Its ownership and identity must be explicit before those adapters
are implemented.

## Decision

An evaluation record binds one durable run to:

- repository identity and pinned starting commit;
- workflow checksum;
- canonical run-configuration checksum;
- dataset ID, author version, and compiled checksum;
- dataset case ID;
- operator-declared experiment ID;
- evaluator version and creation time.

The application evaluates only durable run state already present in the run
store. It never replays repository side effects. The evaluation store persists
the complete binding and report through a declared port. SQLite implements the
port in a separate adapter and uses idempotency keys to prevent duplicate
records.

Repository datasets are discovered only from regular JSON files directly
under `<repository>/.kouro/evaluations/`. The local loader parses and compiles
every selected definition before application use. The loader is infrastructure;
the pure compiler does not import filesystem APIs.

Human evidence is additive and append-only:

- an annotation records an actor, `pass`, `fail`, or `unsure`, and a note for
  one report;
- a pairwise preference records an actor's choice of the left report, right
  report, or tie inside one experiment.

Annotations and preferences do not rewrite deterministic checks. API, CLI, and
web views present both forms of evidence separately.

Evaluators remain observational. Reports, annotations, and preferences cannot
schedule nodes, mutate graphs, grant approval, change permissions, or publish
delivery. A future evaluation gate or model judge requires a separate ADR and
an explicit recovery policy.

## Consequences

- Experiment comparisons retain all decision-affecting checksums instead of
  relying on mutable names.
- Re-evaluation is idempotent for the same operator request while a distinct
  request can intentionally create another timestamped observation.
- Checked-in datasets remain reviewable with repository changes and require no
  company-wide memory service.
- Human judgments preserve their authorship and do not obscure deterministic
  evaluator output.
- SQLite gains additive evaluation tables; existing run and event tables are
  unchanged.
- Automatic case execution, artifact-content rubrics, statistical aggregation,
  and model-based judges remain outside this milestone.

## Alternatives considered

### Store evaluation output as run events

Rejected because evaluation is observational and must not alter durable runtime
history or scheduling decisions.

### Put filesystem loading in the compiler

Rejected because the compiler is a deterministic functional core. Repository
access belongs to an infrastructure adapter.

### Let annotations override deterministic status

Rejected because machine evidence and human judgment answer different
questions and must remain independently auditable.

### Use a hosted experiment service or Kyuki

Rejected because Kouro evaluations are repository-local and must not depend on
company/team-wide memory or hosted tracing state.
