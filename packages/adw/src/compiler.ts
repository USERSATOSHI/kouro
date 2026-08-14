import { ok, type Result } from '@usersatoshi/results';

import type {
  AgentReasoningEffort,
  CompiledTransition,
  CompiledWorkflowArtifact,
  CompiledWorkflowBundle,
  Expression,
  JsonValue,
  RecoveryPolicy,
  SourceNodeDefinition,
  SourceSubagentDefinition,
  SourceTransition,
  WorkflowSourceBundle,
} from '@kouro/domain';
import { CompilerErrorKind, toCompilerError, type CompilerError } from './errors.ts';
import { canonicalJson, compareCanonicalText, sha256 } from './canonical.ts';

const NODE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
const SUBAGENT_CAPABILITIES = new Set(['repository.read']);

function isAgentReasoningEffort(value: unknown): value is AgentReasoningEffort {
  return value === 'low' || value === 'medium' || value === 'high';
}

function isRecoveryPolicy(value: unknown): value is RecoveryPolicy {
  return (
    value === 'replay_safe' ||
    value === 'verify_then_replay' ||
    value === 'resume_supported' ||
    value === 'manual_reconciliation' ||
    value === 'never_automatically_retry'
  );
}

function expressionError(
  expression: Expression,
  counters: Readonly<Record<string, number>>,
): string | undefined {
  if (expression.op === 'and' || expression.op === 'or') {
    if (expression.expressions.length === 0) {
      return `${expression.op} requires at least one child`;
    }
    for (const child of expression.expressions) {
      const error = expressionError(child, counters);
      if (error) return error;
    }
    return undefined;
  }

  if (expression.op === 'not') {
    return expressionError(expression.expression, counters);
  }

  if (expression.left.scope === 'counter' && counters[expression.left.name] === undefined) {
    return `unknown counter: ${expression.left.name}`;
  }
  if (expression.left.scope === 'output' && expression.left.path.length === 0) {
    return 'output reference path must not be empty';
  }
  if (
    (expression.op === 'gte' || expression.op === 'lt') &&
    (typeof expression.right !== 'number' || !Number.isFinite(expression.right))
  ) {
    return `${expression.op} requires a finite numeric right operand`;
  }
  return undefined;
}

function nodeConfigurationError(node: SourceNodeDefinition): string | undefined {
  if (node.priority !== undefined && !Number.isSafeInteger(node.priority)) {
    return 'priority must be a safe integer';
  }
  if (
    node.capabilities?.some((capability) => typeof capability !== 'string' || !capability.trim())
  ) {
    return 'capabilities must be non-empty strings';
  }
  if (node.skipOutcome !== undefined && !node.skipOutcome.trim()) {
    return 'skipOutcome must be a non-empty transition outcome';
  }
  if (node.type === 'complete' && node.skipOutcome !== undefined) {
    return 'complete nodes cannot be skipped';
  }
  if (node.clearContext !== undefined && node.type !== 'agent') {
    return 'clearContext is supported only for agent nodes';
  }
  if (node.clearContext !== undefined && typeof node.clearContext !== 'boolean') {
    return 'clearContext must be a boolean';
  }
  if (node.harness !== undefined && node.type !== 'agent') {
    return 'harness is supported only for agent nodes';
  }
  if (node.harness !== undefined && (typeof node.harness !== 'string' || !node.harness.trim())) {
    return 'harness must be a non-empty harness ID';
  }
  if (node.models !== undefined && node.type !== 'agent') {
    return 'models is supported only on agent nodes';
  }
  if (node.reasoningEffort !== undefined && node.type !== 'agent') {
    return 'reasoningEffort is supported only on agent nodes';
  }
  if (node.reasoningEffort !== undefined && !isAgentReasoningEffort(node.reasoningEffort)) {
    return 'reasoningEffort must be low, medium, or high';
  }
  if (node.allowedSubagents !== undefined && node.type !== 'agent') {
    return 'allowedSubagents is supported only on agent nodes';
  }
  if (
    node.allowedSubagents?.some(
      (subagentId) => typeof subagentId !== 'string' || !subagentId.trim(),
    )
  ) {
    return 'allowedSubagents must contain non-empty subagent IDs';
  }
  if (
    node.allowedSubagents &&
    new Set(node.allowedSubagents).size !== node.allowedSubagents.length
  ) {
    return 'allowedSubagents must not contain duplicates';
  }
  if (node.contextSources !== undefined && node.type !== 'agent') {
    return 'contextSources is supported only on agent nodes';
  }
  if (
    node.contextSources !== undefined &&
    (node.contextSources.length === 0 ||
      node.contextSources.some(
        (source) =>
          !source ||
          !['agent', 'subagent'].includes(source.type) ||
          typeof source.id !== 'string' ||
          !source.id.trim(),
      ))
  ) {
    return 'contextSources must contain typed non-empty source IDs';
  }
  if (
    node.contextSources &&
    new Set(node.contextSources.map(({ type, id }) => `${type}:${id}`)).size !==
      node.contextSources.length
  ) {
    return 'contextSources must not contain duplicates';
  }
  if (node.models !== undefined) {
    if (
      typeof node.models !== 'object' ||
      node.models === null ||
      Array.isArray(node.models) ||
      Object.keys(node.models).length === 0
    ) {
      return 'models must be a non-empty harness-to-model object';
    }
    if (
      Object.entries(node.models).some(
        ([harnessId, model]) => !harnessId.trim() || typeof model !== 'string' || !model.trim(),
      )
    ) {
      return 'models must contain non-empty harness IDs and model identifiers';
    }
  }

  switch (node.type) {
    case 'agent':
      if (!node.role?.trim()) return 'agent role is required';
      if (!node.prompt?.trim()) return 'agent prompt is required';
      if (!isRecoveryPolicy(node.recoveryPolicy)) {
        return 'agent recoveryPolicy is unsupported';
      }
      return undefined;
    case 'approval':
      return node.title?.trim() ? undefined : 'approval title is required';
    case 'delivery_review':
      if (!node.title?.trim()) return 'delivery review title is required';
      if (!node.proposalFrom?.trim()) return 'delivery review proposalFrom is required';
      if (node.skipOutcome !== undefined) return 'delivery review nodes cannot be skipped';
      return undefined;
    case 'command':
      if (!node.command?.trim()) return 'command is required';
      if (!isRecoveryPolicy(node.recoveryPolicy)) {
        return 'command recoveryPolicy is unsupported';
      }
      return undefined;
    case 'complete':
      return node.result === undefined || node.result === 'succeeded' || node.result === 'failed'
        ? undefined
        : 'complete result must be succeeded or failed';
    default:
      return 'node type is unsupported';
  }
}

function subagentConfigurationError(subagent: SourceSubagentDefinition): string | undefined {
  if (typeof subagent.role !== 'string' || !subagent.role.trim()) return 'role is required';
  if (typeof subagent.prompt !== 'string' || !subagent.prompt.trim()) return 'prompt is required';
  if (
    !Array.isArray(subagent.capabilities) ||
    subagent.capabilities.length !== 1 ||
    !SUBAGENT_CAPABILITIES.has(subagent.capabilities[0] ?? '')
  ) {
    return 'capabilities must contain exactly repository.read';
  }
  if (
    subagent.harness !== undefined &&
    (typeof subagent.harness !== 'string' || !subagent.harness.trim())
  ) {
    return 'harness must be a non-empty harness ID';
  }
  if (subagent.models !== undefined) {
    if (
      typeof subagent.models !== 'object' ||
      subagent.models === null ||
      Array.isArray(subagent.models) ||
      Object.keys(subagent.models).length === 0
    ) {
      return 'models must be a non-empty harness-to-model object';
    }
    if (
      Object.entries(subagent.models).some(
        ([harnessId, model]) => !harnessId.trim() || typeof model !== 'string' || !model.trim(),
      )
    ) {
      return 'models must contain non-empty harness IDs and model identifiers';
    }
  }
  if (subagent.reasoningEffort !== undefined && !isAgentReasoningEffort(subagent.reasoningEffort)) {
    return 'reasoningEffort must be low, medium, or high';
  }
  if (!Number.isSafeInteger(subagent.maxInvocations) || subagent.maxInvocations <= 0) {
    return 'maxInvocations must be a positive safe integer';
  }
  if (!Number.isSafeInteger(subagent.maxConcurrent) || subagent.maxConcurrent <= 0) {
    return 'maxConcurrent must be a positive safe integer';
  }
  if (subagent.maxConcurrent > subagent.maxInvocations) {
    return 'maxConcurrent must not exceed maxInvocations';
  }
  return undefined;
}

function unreachableNodes(
  entryNodeId: string,
  nodeIds: ReadonlySet<string>,
  transitions: readonly SourceTransition[],
): readonly string[] {
  const outgoing = new Map<string, string[]>();
  for (const transition of transitions) {
    const targets = outgoing.get(transition.from.nodeId) ?? [];
    targets.push(transition.toNodeId);
    outgoing.set(transition.from.nodeId, targets);
  }
  const reachable = new Set<string>();
  const queue = [entryNodeId];
  for (let index = 0; index < queue.length; index += 1) {
    const nodeId = queue[index];
    if (nodeId === undefined) {
      break;
    }
    if (reachable.has(nodeId)) continue;
    reachable.add(nodeId);
    for (const target of outgoing.get(nodeId) ?? []) {
      queue.push(target);
    }
  }
  return [...nodeIds].filter((nodeId) => !reachable.has(nodeId)).toSorted();
}

function isCounterBound(
  expression: Expression | undefined,
  counter: string,
  limit: number,
): boolean {
  if (!expression) {
    return false;
  }

  if (
    expression.op === 'lt' &&
    expression.left.scope === 'counter' &&
    expression.left.name === counter &&
    expression.right === limit
  ) {
    return true;
  }

  if (expression.op === 'and') {
    return expression.expressions.some((child) => isCounterBound(child, counter, limit));
  }

  return false;
}

function isBoundedEdge(
  transition: SourceTransition,
  limits: Readonly<Record<string, number>>,
): boolean {
  if (!transition.increment) {
    return false;
  }

  const limit = limits[transition.increment];
  return limit !== undefined && isCounterBound(transition.condition, transition.increment, limit);
}

function findCycle(
  nodeIds: readonly string[],
  transitions: readonly SourceTransition[],
  limits: Readonly<Record<string, number>>,
): readonly string[] | undefined {
  const edges = new Map<string, string[]>(nodeIds.map((nodeId) => [nodeId, []]));

  for (const transition of transitions) {
    if (!isBoundedEdge(transition, limits)) {
      edges.get(transition.from.nodeId)?.push(transition.toNodeId);
    }
  }

  for (const targets of edges.values()) {
    targets.sort();
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const visit = (nodeId: string): readonly string[] | undefined => {
    if (visiting.has(nodeId)) {
      const start = stack.indexOf(nodeId);
      return [...stack.slice(start), nodeId];
    }
    if (visited.has(nodeId)) {
      return undefined;
    }

    visiting.add(nodeId);
    stack.push(nodeId);
    for (const target of edges.get(nodeId) ?? []) {
      const cycle = visit(target);
      if (cycle) {
        return cycle;
      }
    }
    stack.pop();
    visiting.delete(nodeId);
    visited.add(nodeId);
    return undefined;
  };

  for (const nodeId of nodeIds.toSorted()) {
    const cycle = visit(nodeId);
    if (cycle) {
      return cycle;
    }
  }

  return undefined;
}

type NodeValidationError = Extract<
  CompilerError,
  {
    kind:
      | CompilerErrorKind.InvalidNodeId
      | CompilerErrorKind.DuplicateNode
      | CompilerErrorKind.InvalidNodeConfiguration;
  }
>;

type TransitionIdentityError = Extract<
  CompilerError,
  {
    kind:
      | CompilerErrorKind.InvalidTransition
      | CompilerErrorKind.DuplicateTransition
      | CompilerErrorKind.TransitionNodeNotFound;
  }
>;

type TransitionSemanticsError = Extract<
  CompilerError,
  {
    kind:
      | CompilerErrorKind.UnknownCounter
      | CompilerErrorKind.InvalidDefault
      | CompilerErrorKind.InvalidExpression;
  }
>;

type TransitionValidationError = TransitionIdentityError | TransitionSemanticsError;

function validateNodes(
  nodes: readonly SourceNodeDefinition[],
): Result<ReadonlySet<string>, NodeValidationError> {
  const nodeIds = new Set<string>();
  for (const node of nodes) {
    if (!NODE_ID_PATTERN.test(node.id)) {
      return toCompilerError(CompilerErrorKind.InvalidNodeId, {
        nodeId: node.id,
      });
    }
    if (nodeIds.has(node.id)) {
      return toCompilerError(CompilerErrorKind.DuplicateNode, {
        nodeId: node.id,
      });
    }
    nodeIds.add(node.id);

    const configurationError = nodeConfigurationError(node);
    if (configurationError) {
      return toCompilerError(CompilerErrorKind.InvalidNodeConfiguration, {
        nodeId: node.id,
        reason: configurationError,
      });
    }
  }
  return ok(nodeIds);
}

function validateSubagents(subagents: readonly SourceSubagentDefinition[]): Result<
  ReadonlyMap<string, SourceSubagentDefinition>,
  Extract<
    CompilerError,
    {
      kind:
        | CompilerErrorKind.InvalidSubagentId
        | CompilerErrorKind.DuplicateSubagent
        | CompilerErrorKind.InvalidSubagentConfiguration;
    }
  >
> {
  const definitions = new Map<string, SourceSubagentDefinition>();
  for (const subagent of subagents) {
    if (!NODE_ID_PATTERN.test(subagent.id)) {
      return toCompilerError(CompilerErrorKind.InvalidSubagentId, {
        subagentId: subagent.id,
      });
    }
    if (definitions.has(subagent.id)) {
      return toCompilerError(CompilerErrorKind.DuplicateSubagent, {
        subagentId: subagent.id,
      });
    }
    const configurationError = subagentConfigurationError(subagent);
    if (configurationError) {
      return toCompilerError(CompilerErrorKind.InvalidSubagentConfiguration, {
        subagentId: subagent.id,
        reason: configurationError,
      });
    }
    definitions.set(subagent.id, subagent);
  }
  return ok(definitions);
}

function validateEntryNode(
  entryNodeId: string,
  nodeIds: ReadonlySet<string>,
): Result<void, Extract<CompilerError, { kind: CompilerErrorKind.EntryNodeNotFound }>> {
  if (!nodeIds.has(entryNodeId)) {
    return toCompilerError(CompilerErrorKind.EntryNodeNotFound, {
      nodeId: entryNodeId,
    });
  }
  return ok(undefined);
}

function validateCounterLimits(
  counterLimits: Readonly<Record<string, number>>,
): Result<void, Extract<CompilerError, { kind: CompilerErrorKind.InvalidCounterLimit }>> {
  for (const [counter, limit] of Object.entries(counterLimits)) {
    if (!Number.isSafeInteger(limit) || limit < 0) {
      return toCompilerError(CompilerErrorKind.InvalidCounterLimit, {
        counter,
        limit,
      });
    }
  }
  return ok(undefined);
}

function validateRunLimits(
  source: WorkflowSourceBundle,
): Result<void, Extract<CompilerError, { kind: CompilerErrorKind.InvalidRunLimit }>> {
  for (const [limit, value] of Object.entries(source.runLimits ?? {})) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      return toCompilerError(CompilerErrorKind.InvalidRunLimit, {
        limit: limit === 'maxDurationMs' ? 'maxDurationMs' : 'maxNodeInvocations',
        value,
      });
    }
  }
  return ok(undefined);
}

function validatePermissions(
  nodes: readonly SourceNodeDefinition[],
  subagents: readonly SourceSubagentDefinition[],
  permissions: readonly string[],
): Result<void, Extract<CompilerError, { kind: CompilerErrorKind.PermissionNotDeclared }>> {
  const declaredPermissions = new Set(permissions);
  for (const node of nodes) {
    for (const permission of node.capabilities ?? []) {
      if (!declaredPermissions.has(permission)) {
        return toCompilerError(CompilerErrorKind.PermissionNotDeclared, {
          nodeId: node.id,
          permission,
        });
      }
    }
  }
  for (const subagent of subagents) {
    for (const permission of subagent.capabilities) {
      if (!declaredPermissions.has(permission)) {
        return toCompilerError(CompilerErrorKind.PermissionNotDeclared, {
          nodeId: `subagent:${subagent.id}`,
          permission,
        });
      }
    }
  }
  return ok(undefined);
}

function validateSubagentAuthorization(
  nodes: readonly SourceNodeDefinition[],
  subagents: ReadonlyMap<string, SourceSubagentDefinition>,
): Result<
  void,
  Extract<
    CompilerError,
    {
      kind: CompilerErrorKind.UnknownSubagent | CompilerErrorKind.SubagentCapabilityEscalation;
    }
  >
> {
  for (const node of nodes) {
    const parentCapabilities = new Set(node.capabilities ?? []);
    for (const subagentId of node.allowedSubagents ?? []) {
      const subagent = subagents.get(subagentId);
      if (!subagent) {
        return toCompilerError(CompilerErrorKind.UnknownSubagent, {
          nodeId: node.id,
          subagentId,
        });
      }
      for (const capability of subagent.capabilities) {
        if (!parentCapabilities.has(capability)) {
          return toCompilerError(CompilerErrorKind.SubagentCapabilityEscalation, {
            nodeId: node.id,
            subagentId,
            capability,
          });
        }
      }
    }
  }
  return ok(undefined);
}

function validateContextSources(
  nodes: readonly SourceNodeDefinition[],
  subagents: ReadonlyMap<string, SourceSubagentDefinition>,
): Result<void, Extract<CompilerError, { kind: CompilerErrorKind.InvalidNodeConfiguration }>> {
  const definitions = new Map(nodes.map((node) => [node.id, node]));
  for (const consumer of nodes) {
    for (const source of consumer.contextSources ?? []) {
      const valid =
        source.type === 'subagent'
          ? subagents.has(source.id)
          : source.id !== consumer.id && definitions.get(source.id)?.type === 'agent';
      if (!valid) {
        return toCompilerError(CompilerErrorKind.InvalidNodeConfiguration, {
          nodeId: consumer.id,
          reason: `unknown or invalid ${source.type} context source: ${source.id}`,
        });
      }
    }
  }
  return ok(undefined);
}

function validateTransitionIdentity(
  transition: SourceTransition,
  transitionIds: ReadonlySet<string>,
  nodeIds: ReadonlySet<string>,
): Result<void, TransitionIdentityError> {
  if (
    !transition.id.trim() ||
    !transition.from.nodeId.trim() ||
    !transition.from.outcome.trim() ||
    !transition.toNodeId.trim()
  ) {
    return toCompilerError(CompilerErrorKind.InvalidTransition, {
      transitionId: transition.id,
      reason: 'transition id, source node, outcome, and target are required',
    });
  }
  if (transitionIds.has(transition.id)) {
    return toCompilerError(CompilerErrorKind.DuplicateTransition, {
      transitionId: transition.id,
    });
  }
  for (const nodeId of [transition.from.nodeId, transition.toNodeId]) {
    if (!nodeIds.has(nodeId)) {
      return toCompilerError(CompilerErrorKind.TransitionNodeNotFound, {
        transitionId: transition.id,
        nodeId,
      });
    }
  }
  return ok(undefined);
}

function validateTransitionSemantics(
  transition: SourceTransition,
  counterLimits: Readonly<Record<string, number>>,
  defaults: ReadonlySet<string>,
): Result<string | undefined, TransitionSemanticsError> {
  if (transition.increment && counterLimits[transition.increment] === undefined) {
    return toCompilerError(CompilerErrorKind.UnknownCounter, {
      transitionId: transition.id,
      counter: transition.increment,
    });
  }

  let defaultKey: string | undefined;
  if (transition.default) {
    defaultKey = `${transition.from.nodeId}\0${transition.from.outcome}`;
    if (transition.condition || defaults.has(defaultKey)) {
      return toCompilerError(CompilerErrorKind.InvalidDefault, {
        nodeId: transition.from.nodeId,
        outcome: transition.from.outcome,
      });
    }
  }

  if (transition.condition) {
    const reason = expressionError(transition.condition, counterLimits);
    if (reason) {
      return toCompilerError(CompilerErrorKind.InvalidExpression, {
        transitionId: transition.id,
        reason,
      });
    }
  }
  return ok(defaultKey);
}

function validateTransitions(
  transitions: readonly SourceTransition[],
  nodeIds: ReadonlySet<string>,
  counterLimits: Readonly<Record<string, number>>,
): Result<void, TransitionValidationError> {
  const transitionIds = new Set<string>();
  const defaults = new Set<string>();
  for (const transition of transitions) {
    const identity = validateTransitionIdentity(transition, transitionIds, nodeIds);
    if (identity.isErr()) {
      return identity;
    }

    const semantics = validateTransitionSemantics(transition, counterLimits, defaults);
    if (semantics.isErr()) {
      return semantics;
    }

    transitionIds.add(transition.id);
    const defaultKey = semantics.unwrapOr(undefined);
    if (defaultKey !== undefined) {
      defaults.add(defaultKey);
    }
  }
  return ok(undefined);
}

function validateGraph(
  source: WorkflowSourceBundle,
  nodeIds: ReadonlySet<string>,
): Result<
  void,
  Extract<
    CompilerError,
    { kind: CompilerErrorKind.UnreachableNode | CompilerErrorKind.UnboundedCycle }
  >
> {
  const unreachable = unreachableNodes(source.entryNodeId, nodeIds, source.transitions);
  if (unreachable.length > 0) {
    return toCompilerError(CompilerErrorKind.UnreachableNode, {
      nodeIds: unreachable,
    });
  }

  const cycle = findCycle([...nodeIds], source.transitions, source.counterLimits);
  if (cycle) {
    return toCompilerError(CompilerErrorKind.UnboundedCycle, {
      nodeIds: cycle,
    });
  }
  return ok(undefined);
}

function validate(source: WorkflowSourceBundle): Result<void, CompilerError> {
  const nodes = validateNodes(source.nodes);
  if (nodes.isErr()) return nodes;
  const nodeIds = nodes.unwrap();
  const subagents = validateSubagents(source.subagents ?? []);
  if (subagents.isErr()) return subagents;

  const entry = validateEntryNode(source.entryNodeId, nodeIds);
  if (entry.isErr()) return entry;

  const counters = validateCounterLimits(source.counterLimits);
  if (counters.isErr()) return counters;

  const runLimits = validateRunLimits(source);
  if (runLimits.isErr()) return runLimits;

  const permissions = validatePermissions(
    source.nodes,
    source.subagents ?? [],
    source.permissions ?? [],
  );
  if (permissions.isErr()) return permissions;
  const authorization = validateSubagentAuthorization(source.nodes, subagents.unwrap());
  if (authorization.isErr()) return authorization;
  const contextSources = validateContextSources(source.nodes, subagents.unwrap());
  if (contextSources.isErr()) return contextSources;

  const transitions = validateTransitions(source.transitions, nodeIds, source.counterLimits);
  if (transitions.isErr()) return transitions;

  for (const node of source.nodes) {
    if (
      node.type === 'delivery_review' &&
      !source.nodes.some(({ id, type }) => id === node.proposalFrom && type === 'agent')
    ) {
      return toCompilerError(CompilerErrorKind.InvalidNodeConfiguration, {
        nodeId: node.id,
        reason: `proposalFrom must name an agent node: ${node.proposalFrom}`,
      });
    }
    if (node.type === 'delivery_review') {
      for (const outcome of ['approved', 'changes_requested', 'rejected']) {
        if (
          !source.transitions.some(
            ({ from }) => from.nodeId === node.id && from.outcome === outcome,
          )
        ) {
          return toCompilerError(CompilerErrorKind.InvalidNodeConfiguration, {
            nodeId: node.id,
            reason: `delivery review requires a ${outcome} transition`,
          });
        }
      }
    }
  }

  for (const node of source.nodes) {
    if (
      node.skipOutcome &&
      !source.transitions.some(
        ({ from }) => from.nodeId === node.id && from.outcome === node.skipOutcome,
      )
    ) {
      return toCompilerError(CompilerErrorKind.InvalidNodeConfiguration, {
        nodeId: node.id,
        reason: `skipOutcome has no declared transition: ${node.skipOutcome}`,
      });
    }
  }

  return validateGraph(source, nodeIds);
}

export function compileWorkflow(
  source: WorkflowSourceBundle,
): Result<CompiledWorkflowArtifact, CompilerError> {
  const validation = validate(source);
  if (validation.isErr()) {
    return validation;
  }

  const sortedNodeIds = source.nodes.map((node) => node.id).toSorted(compareCanonicalText);
  const ordinals = new Map(sortedNodeIds.map((nodeId, ordinal) => [nodeId, ordinal]));
  const nodes = source.nodes
    .map((node) => {
      const ordinal = ordinals.get(node.id);
      if (ordinal === undefined) {
        throw new Error(`Missing ordinal for validated node: ${node.id}`);
      }
      return {
        ...node,
        ...(node.capabilities ? { capabilities: node.capabilities.toSorted() } : {}),
        ...(node.allowedSubagents
          ? { allowedSubagents: node.allowedSubagents.toSorted(compareCanonicalText) }
          : {}),
        ...(node.contextSources
          ? {
              contextSources: node.contextSources.toSorted(
                (left, right) =>
                  compareCanonicalText(left.type, right.type) ||
                  compareCanonicalText(left.id, right.id),
              ),
            }
          : {}),
        priority: node.priority ?? 0,
        ordinal,
      };
    })
    .toSorted((left, right) => left.ordinal - right.ordinal);
  const subagents = (source.subagents ?? [])
    .map((subagent) => ({
      ...subagent,
      capabilities: subagent.capabilities.toSorted(compareCanonicalText),
    }))
    .toSorted((left, right) => compareCanonicalText(left.id, right.id));
  const transitions: CompiledTransition[] = source.transitions.toSorted((left, right) =>
    compareCanonicalText(left.id, right.id),
  );

  const bundle: CompiledWorkflowBundle = {
    ...source,
    nodes,
    ...(subagents.length > 0 ? { subagents } : {}),
    transitions,
    permissions: (source.permissions ?? []).toSorted(),
  };
  // Domain bundle fields are JSON-only, but interfaces do not satisfy JsonValue's index signature.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const canonical = canonicalJson(bundle as unknown as JsonValue);

  return ok({
    bundle,
    canonical,
    checksum: sha256(canonical),
  });
}
