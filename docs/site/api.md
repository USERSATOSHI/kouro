# Build workflows with Kouro

Kouro separates declarative workflow authoring from compilation and durable execution.
Start with {@link WorkflowBuilder}, declare inputs and agents, wire control flow, then export `workflow.build()`.

The <a href="../guide.html">first workflow guide</a> explains installation, models, typed outputs, and running your workflow.
The <a href="../examples.html">examples page</a> contains complete, downloadable workflows checked by the Kouro compiler.

## Authoring essentials

- {@link WorkflowBuilder.agent | .agent}: declare an agent, its prompt, inputs, output schema, permissions, and optional model.
- {@link WorkflowBuilder.subagent | .subagent}: declare a bounded, read-only child agent. Grant it through an agent's `uses` option.
- {@link artifactType}: associate a TypeScript output type with a runtime JSON Schema.
- {@link WorkflowBuilder.approval | .approval}: wait for an operator decision before proceeding.
- {@link WorkflowBuilder.command | .command}: run a deterministic validation step.
- {@link WorkflowBuilder.parallel | .parallel} and {@link WorkflowBuilder.join | .join}: fork independent branches and wait for them.
- {@link WorkflowBuilder.fusion | .fusion(...).use(...)}: compose declared agents into parallel drafts, bounded review/revision rounds, and synthesis.
- {@link WorkflowBuilder.milestones | .milestones(...).use(...)}: schedule supplied workflows according to a validated dependency plan.
- {@link NodeHandle.on} and {@link EdgeBuilder.repair}: connect outcomes and bound repair attempts.
- {@link ReasoningEffort}: named reasoning levels for agent and subagent nodes, such as `ReasoningEffort.HIGH`.
- {@link compileWorkflow}: validate a workflow definition and produce an immutable bundle.

The reference also documents the exported execution, contract, and lifecycle APIs. Use the search to find a type or method.
