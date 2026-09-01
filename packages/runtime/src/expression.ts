import { ok, type Result } from '@usersatoshi/results';

import type { Expression, JsonPrimitive, JsonValue, RunState } from '@kouro/domain';
import { RuntimeErrorKind, toRuntimeError, type RuntimeError } from './errors.ts';

function isJsonObject(value: JsonValue): value is Readonly<Record<string, JsonValue>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readOutputPath(
  output: JsonValue | undefined,
  path: readonly string[],
): JsonValue | undefined {
  let current = output;
  for (const segment of path) {
    if (current === undefined) {
      return undefined;
    }
    if (isJsonObject(current)) {
      current = current[segment];
      continue;
    }
    if (Array.isArray(current) && /^\d+$/.test(segment)) {
      current = current[Number(segment)];
      continue;
    }
    return undefined;
  }
  return current;
}

function resolveLeft(
  expression: Extract<Expression, { left: unknown }>,
  state: RunState,
  output: JsonValue | undefined,
  input: JsonValue | undefined,
): Result<JsonValue | undefined, RuntimeError> {
  if (expression.left.scope === 'counter') {
    const value = state.counters[expression.left.name];
    if (value === undefined) {
      return toRuntimeError(RuntimeErrorKind.UnknownCounter, {
        counter: expression.left.name,
      });
    }
    return ok(value);
  }

  return ok(
    readOutputPath(expression.left.scope === 'input' ? input : output, expression.left.path),
  );
}

function compare(
  op: 'eq' | 'gte' | 'lt',
  left: JsonValue | undefined,
  right: JsonPrimitive,
): Result<boolean, RuntimeError> {
  if (op === 'eq') {
    return ok(left === right);
  }
  if (typeof left !== 'number' || typeof right !== 'number') {
    return toRuntimeError(RuntimeErrorKind.InvalidExpression, {
      reason: `${op} requires numeric operands`,
    });
  }
  return ok(op === 'lt' ? left < right : left >= right);
}

export function evaluateExpression(
  expression: Expression,
  state: RunState,
  output: JsonValue | undefined,
  input?: JsonValue,
): Result<boolean, RuntimeError> {
  if (expression.op === 'not') {
    const result = evaluateExpression(expression.expression, state, output, input);
    return result.isErr() ? result : ok(!result.unwrap());
  }

  if (expression.op === 'and' || expression.op === 'or') {
    const target = expression.op === 'and';
    for (const child of expression.expressions) {
      const result = evaluateExpression(child, state, output, input);
      if (result.isErr()) {
        return result;
      }
      if (result.unwrap() !== target) {
        return ok(!target);
      }
    }
    return ok(target);
  }

  const left = resolveLeft(expression, state, output, input);
  if (left.isErr()) {
    return left;
  }
  return compare(expression.op, left.unwrapOr(undefined), expression.right);
}
