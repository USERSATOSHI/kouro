import { ok, type Result } from '@usersatoshi/results';

import type {
  CompiledBranchDefinition,
  CompiledWorkflowBundle,
  Expression,
  InvocationScope,
  JsonValue,
  SourceNodeDefinition,
  SourceSubagentDefinition,
  SourceTransition,
  WorkflowSourceBundle,
} from '@kouro/domain';
import { compareCanonicalText } from './canonical.ts';
import { CompilerErrorKind, toCompilerError, type CompilerError } from './errors.ts';

interface Expansion {
  readonly entryNodeId: string;
  readonly nodes: readonly SourceNodeDefinition[];
  readonly subagents: readonly SourceSubagentDefinition[];
  readonly transitions: readonly SourceTransition[];
  readonly counterLimits: Readonly<Record<string, number>>;
  readonly prompts: Readonly<Record<string, string>>;
  readonly schemas: Readonly<Record<string, JsonValue>>;
  readonly returnNodes: readonly {
    readonly id: string;
    readonly outcome: 'succeeded' | 'failed';
  }[];
}

function namespaced(prefix: string, value: string): string {
  return `${prefix}/${value}`;
}

function nestedScope(
  existing: InvocationScope | undefined,
  outer: InvocationScope,
): InvocationScope {
  return existing ? { ...existing, parent: nestedScope(existing.parent, outer) } : outer;
}

function namespaceExpression(expression: Expression, prefix: string): Expression {
  if (expression.op === 'and' || expression.op === 'or') {
    return {
      ...expression,
      expressions: expression.expressions.map((child) => namespaceExpression(child, prefix)),
    };
  }
  if (expression.op === 'not') {
    return { ...expression, expression: namespaceExpression(expression.expression, prefix) };
  }
  return expression.left.scope === 'counter'
    ? {
        ...expression,
        left: { ...expression.left, name: namespaced(prefix, expression.left.name) },
      }
    : expression;
}

function namespaceResource(prefix: string, resource: string | undefined): string | undefined {
  return resource === undefined ? undefined : namespaced(prefix, resource);
}

function expandBundle(
  bundle: CompiledWorkflowBundle,
  prefix: string,
  scope: InvocationScope,
  terminalType: 'gateway' | 'branch_return',
): Expansion {
  const remap = (id: string): string => namespaced(prefix, id);
  const nodes: SourceNodeDefinition[] = [];
  const returnNodes: { id: string; outcome: 'succeeded' | 'failed' }[] = [];
  for (const node of bundle.nodes) {
    const id = remap(node.id);
    if (node.type === 'complete') {
      const outcome = node.result ?? 'succeeded';
      nodes.push({
        id,
        type: terminalType,
        automaticOutcome: outcome,
        scope: nestedScope(node.scope, scope),
      });
      returnNodes.push({ id, outcome });
      continue;
    }
    const branches = Array.isArray(node.branches)
      ? node.branches.map((branch) => ({
          ...branch,
          entryNodeId: remap(branch.entryNodeId),
          returnNodeIds: branch.returnNodeIds.map(remap),
        }))
      : node.branches;
    nodes.push({
      ...node,
      id,
      ...(node.prompt ? { prompt: namespaceResource(prefix, node.prompt) } : {}),
      ...(node.outputSchema ? { outputSchema: namespaceResource(prefix, node.outputSchema) } : {}),
      ...(node.payloadSchema
        ? { payloadSchema: namespaceResource(prefix, node.payloadSchema) }
        : {}),
      ...(node.proposalFrom ? { proposalFrom: remap(node.proposalFrom) } : {}),
      ...(node.allowedSubagents ? { allowedSubagents: node.allowedSubagents.map(remap) } : {}),
      ...(node.contextSources
        ? {
            contextSources: node.contextSources.map((source) => ({
              ...source,
              id: remap(source.id),
            })),
          }
        : {}),
      ...(branches ? { branches } : {}),
      ...(node.template
        ? {
            template: {
              entryNodeId: remap(node.template.entryNodeId),
              returnNodeIds: node.template.returnNodeIds.map(remap),
            },
          }
        : {}),
      ...(node.itemsFrom
        ? { itemsFrom: { ...node.itemsFrom, nodeId: remap(node.itemsFrom.nodeId) } }
        : {}),
      scope: nestedScope(node.scope, scope),
    });
  }
  return {
    entryNodeId: remap(bundle.entryNodeId),
    nodes,
    subagents: (bundle.subagents ?? []).map((subagent) => ({
      ...subagent,
      id: remap(subagent.id),
      prompt: namespaced(prefix, subagent.prompt),
      ...(subagent.outputSchema ? { outputSchema: namespaced(prefix, subagent.outputSchema) } : {}),
    })),
    transitions: bundle.transitions.map((transition) => ({
      ...transition,
      id: remap(transition.id),
      from: { ...transition.from, nodeId: remap(transition.from.nodeId) },
      toNodeId: remap(transition.toNodeId),
      ...(transition.condition
        ? { condition: namespaceExpression(transition.condition, prefix) }
        : {}),
      ...(transition.increment ? { increment: remap(transition.increment) } : {}),
    })),
    counterLimits: Object.fromEntries(
      Object.entries(bundle.counterLimits).map(([name, limit]) => [remap(name), limit]),
    ),
    prompts: Object.fromEntries(
      Object.entries(bundle.prompts ?? {}).map(([name, prompt]) => [remap(name), prompt]),
    ),
    schemas: Object.fromEntries(
      Object.entries(bundle.schemas ?? {}).map(([name, schema]) => [remap(name), schema]),
    ),
    returnNodes,
  };
}

function childFor(
  source: WorkflowSourceBundle,
  nodeId: string,
  alias: string,
): Result<CompiledWorkflowBundle, CompilerError> {
  const child = source.subworkflows?.[alias]?.bundle;
  if (!child) {
    return toCompilerError(CompilerErrorKind.UnknownSubworkflow, { nodeId, alias });
  }
  if (
    child.semanticVersions.compiler !== source.semanticVersions.compiler ||
    child.semanticVersions.ir !== source.semanticVersions.ir ||
    child.semanticVersions.expressions !== source.semanticVersions.expressions
  ) {
    return toCompilerError(CompilerErrorKind.InvalidComposition, {
      nodeId,
      reason: `subworkflow ${alias} uses incompatible semantic versions`,
    });
  }
  const parentPermissions = new Set(source.permissions ?? []);
  const escalation = (child.permissions ?? []).find(
    (permission) => !parentPermissions.has(permission),
  );
  return escalation
    ? toCompilerError(CompilerErrorKind.SubworkflowPermissionEscalation, {
        nodeId,
        alias,
        permission: escalation,
      })
    : ok(child);
}

function mergeExpansion(source: WorkflowSourceBundle, expansion: Expansion): WorkflowSourceBundle {
  return {
    ...source,
    nodes: [...source.nodes, ...expansion.nodes],
    subagents: [...(source.subagents ?? []), ...expansion.subagents],
    transitions: [...source.transitions, ...expansion.transitions],
    counterLimits: { ...source.counterLimits, ...expansion.counterLimits },
    prompts: { ...source.prompts, ...expansion.prompts },
    schemas: { ...source.schemas, ...expansion.schemas },
  };
}

function expandCall(
  source: WorkflowSourceBundle,
  node: SourceNodeDefinition,
): Result<WorkflowSourceBundle, CompilerError> {
  const alias = node.workflow ?? '';
  const childResult = childFor(source, node.id, alias);
  if (childResult.isErr()) return childResult;
  const invalidOutcome = source.transitions.find(
    (transition) =>
      transition.from.nodeId === node.id &&
      transition.from.outcome !== 'succeeded' &&
      transition.from.outcome !== 'failed',
  );
  if (invalidOutcome) {
    return toCompilerError(CompilerErrorKind.InvalidComposition, {
      nodeId: node.id,
      reason: `call outcome must be succeeded or failed: ${invalidOutcome.from.outcome}`,
    });
  }
  const prefix = `@call/${node.id}`;
  const expansion = expandBundle(
    childResult.unwrap(),
    prefix,
    { kind: 'call', ownerNodeId: node.id },
    'gateway',
  );
  if (expansion.returnNodes.length === 0) {
    return toCompilerError(CompilerErrorKind.InvalidComposition, {
      nodeId: node.id,
      reason: 'call subworkflow must declare a complete node',
    });
  }
  const outgoing = source.transitions.filter(({ from }) => from.nodeId === node.id);
  const missingOutcome = expansion.returnNodes.find(
    ({ outcome }) => !outgoing.some(({ from }) => from.outcome === outcome),
  );
  if (missingOutcome) {
    return toCompilerError(CompilerErrorKind.InvalidComposition, {
      nodeId: node.id,
      reason: `call has no completion mapping for ${missingOutcome.outcome}`,
    });
  }
  const rewrittenOutgoing = expansion.returnNodes.flatMap((returned) =>
    outgoing
      .filter(({ from }) => from.outcome === returned.outcome)
      .map((transition) => ({
        ...transition,
        id: namespaced(returned.id, transition.id),
        from: { nodeId: returned.id, outcome: returned.outcome },
      })),
  );
  const retainedTransitions = source.transitions
    .filter(({ from }) => from.nodeId !== node.id)
    .map((transition) =>
      transition.toNodeId === node.id
        ? { ...transition, toNodeId: expansion.entryNodeId }
        : transition,
    );
  const merged = mergeExpansion(
    {
      ...source,
      entryNodeId: source.entryNodeId === node.id ? expansion.entryNodeId : source.entryNodeId,
      nodes: source.nodes.filter(({ id }) => id !== node.id),
      transitions: [...retainedTransitions, ...rewrittenOutgoing],
    },
    { ...expansion, transitions: expansion.transitions },
  );
  return ok(merged);
}

function forbiddenBranchNode(child: CompiledWorkflowBundle): SourceNodeDefinition | undefined {
  return child.nodes.find((node) =>
    ['approval', 'delivery_review', 'parallel', 'for_each', 'sleep', 'wait_for_event'].includes(
      node.type,
    ),
  );
}

function expandParallel(
  source: WorkflowSourceBundle,
  node: SourceNodeDefinition,
): Result<WorkflowSourceBundle, CompilerError> {
  if (Array.isArray(node.branches) || !node.branches) {
    return toCompilerError(CompilerErrorKind.InvalidComposition, {
      nodeId: node.id,
      reason: 'parallel branches must map branch IDs to subworkflow aliases',
    });
  }
  let next = source;
  const branches: CompiledBranchDefinition[] = [];
  for (const [branchId, alias] of Object.entries(node.branches).toSorted(([left], [right]) =>
    compareCanonicalText(left, right),
  )) {
    const childResult = childFor(source, node.id, alias);
    if (childResult.isErr()) return childResult;
    const child = childResult.unwrap();
    const forbidden = forbiddenBranchNode(child);
    if (forbidden) {
      return toCompilerError(CompilerErrorKind.InvalidComposition, {
        nodeId: node.id,
        reason: `parallel branch ${branchId} contains unsupported ${forbidden.type} node ${forbidden.id}`,
      });
    }
    const prefix = `@parallel/${node.id}/${branchId}`;
    const expansion = expandBundle(
      child,
      prefix,
      { kind: 'parallel', ownerNodeId: node.id, branchId },
      'branch_return',
    );
    if (expansion.returnNodes.length === 0) {
      return toCompilerError(CompilerErrorKind.InvalidComposition, {
        nodeId: node.id,
        reason: `parallel branch ${branchId} must declare a complete node`,
      });
    }
    next = mergeExpansion(next, expansion);
    branches.push({
      id: branchId,
      entryNodeId: expansion.entryNodeId,
      returnNodeIds: expansion.returnNodes.map(({ id }) => id),
    });
  }
  return ok({
    ...next,
    nodes: next.nodes.map((candidate) =>
      candidate.id === node.id ? { ...candidate, branches } : candidate,
    ),
  });
}

function expandForEach(
  source: WorkflowSourceBundle,
  node: SourceNodeDefinition,
): Result<WorkflowSourceBundle, CompilerError> {
  const alias = node.workflow ?? '';
  const childResult = childFor(source, node.id, alias);
  if (childResult.isErr()) return childResult;
  const child = childResult.unwrap();
  const forbidden = forbiddenBranchNode(child);
  if (forbidden) {
    return toCompilerError(CompilerErrorKind.InvalidComposition, {
      nodeId: node.id,
      reason: `forEach workflow contains unsupported ${forbidden.type} node ${forbidden.id}`,
    });
  }
  const expansion = expandBundle(
    child,
    `@forEach/${node.id}`,
    { kind: 'for_each', ownerNodeId: node.id },
    'branch_return',
  );
  if (expansion.returnNodes.length === 0) {
    return toCompilerError(CompilerErrorKind.InvalidComposition, {
      nodeId: node.id,
      reason: 'forEach subworkflow must declare a complete node',
    });
  }
  const next = mergeExpansion(source, expansion);
  return ok({
    ...next,
    nodes: next.nodes.map((candidate) =>
      candidate.id === node.id
        ? {
            ...candidate,
            template: {
              entryNodeId: expansion.entryNodeId,
              returnNodeIds: expansion.returnNodes.map(({ id }) => id),
            },
          }
        : candidate,
    ),
  });
}

/** Expands trusted package composition into immutable compiler-owned graph data. */
export function expandWorkflowComposition(
  source: WorkflowSourceBundle,
): Result<WorkflowSourceBundle, CompilerError> {
  const generated = source.nodes.find(({ id }) => id.startsWith('@'));
  if (generated) {
    return toCompilerError(CompilerErrorKind.GeneratedNodeId, { nodeId: generated.id });
  }
  const generatedSubagent = source.subagents?.find(({ id }) => id.startsWith('@'));
  if (generatedSubagent) {
    return toCompilerError(CompilerErrorKind.GeneratedNodeId, {
      nodeId: `subagent:${generatedSubagent.id}`,
    });
  }
  let expanded = source;
  for (const node of source.nodes) {
    const result =
      node.type === 'call'
        ? expandCall(expanded, node)
        : node.type === 'parallel'
          ? expandParallel(expanded, node)
          : node.type === 'for_each'
            ? expandForEach(expanded, node)
            : ok(expanded);
    if (result.isErr()) return result;
    expanded = result.unwrap();
  }
  return ok(expanded);
}
