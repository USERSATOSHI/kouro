import { ok, type Result } from '@usersatoshi/results';

import type {
  CompiledTransition,
  CompiledWorkflowBundle,
  NodeInvocation,
  RunState,
} from '@kouro/domain';
import { RuntimeErrorKind, toRuntimeError, type RuntimeError } from './errors.ts';
import { evaluateExpression } from './expression.ts';

export function selectTransition(
  workflow: CompiledWorkflowBundle,
  state: RunState,
  invocation: NodeInvocation,
): Result<CompiledTransition, RuntimeError> {
  const candidates = workflow.transitions.filter(
    (transition) =>
      transition.from.nodeId === invocation.nodeId &&
      transition.from.outcome === invocation.outcome,
  );
  const matches: CompiledTransition[] = [];
  let fallback: CompiledTransition | undefined;

  for (const transition of candidates) {
    if (transition.default) {
      fallback = transition;
      continue;
    }

    if (!transition.condition) {
      matches.push(transition);
      continue;
    }

    const evaluated = evaluateExpression(
      transition.condition,
      state,
      invocation.output,
      invocation.input,
    );
    if (evaluated.isErr()) {
      return evaluated;
    }
    if (evaluated.unwrap()) {
      matches.push(transition);
    }
  }

  if (matches.length > 1) {
    return toRuntimeError(RuntimeErrorKind.AmbiguousTransition, {
      nodeId: invocation.nodeId,
      outcome: invocation.outcome ?? '',
      transitionIds: matches.map(({ id }) => id).toSorted(),
    });
  }

  const selected = matches[0] ?? fallback;
  if (!selected) {
    return toRuntimeError(RuntimeErrorKind.MissingTransition, {
      nodeId: invocation.nodeId,
      outcome: invocation.outcome ?? '',
    });
  }

  return ok(selected);
}
