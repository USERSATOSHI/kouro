import type {
  AttemptState,
  BoundInput,
  Bundle,
  DecisionIntent,
  ExecutionState,
  InvocationState,
  LifecycleEvent,
  Node as WorkflowNode,
  ScopeState,
  ForkNode,
  JoinNode,
  CallNode,
} from "./contracts";

/** Create the empty normalized aggregate for one run. No clock or random ID is read. */
export function createInitialState(
  runId: string,
  rootScopeId = `${runId}:root`,
  rootDefinitionId = "root",
): ExecutionState {
  const scope: ScopeState = {
    id: rootScopeId,
    parentScopeId: null,
    definitionId: rootDefinitionId,
    status: "pending",
    activationOrdinal: 0,
  };
  return {
    runId,
    revision: 0,
    eventCursor: 0,
    status: "pending",
    rootScopeId,
    startedAt: null,
    finishedAt: null,
    scopes: { [rootScopeId]: scope },
    forkGroups: {},
    invocations: {},
    attempts: {},
    recovery: null,
    counters: {},
    approvals: {},
    control: "none",
  };
}

/**
 * Purely apply one committed lifecycle fact. The caller owns journal ordering,
 * timestamps, identity allocation, and persistence. The reducer only consumes
 * the supplied event values.
 */
export function reduceEvent(state: ExecutionState, event: LifecycleEvent): ExecutionState {
  if (event.runId !== state.runId)
    throw new Error(`Event belongs to run ${event.runId}, expected ${state.runId}`);
  if (!Number.isSafeInteger(event.sequence) || event.sequence !== state.revision + 1) {
    throw new Error(
      `Event sequence ${event.sequence} must equal revision + 1 (${state.revision + 1})`,
    );
  }
  if (["succeeded", "failed", "cancelled", "interrupted"].includes(state.status)) {
    throw new Error(`Cannot apply ${event.type} after terminal run status ${state.status}`);
  }
  const next = {
    ...state,
    revision: event.sequence,
    eventCursor: event.sequence,
  };
  switch (event.type) {
    case "harness.activity":
      return next;
    case "run.started":
      return runStarted(next, event);
    case "scope.created":
      if (next.scopes[event.payload.scope.id])
        throw new Error(`Scope ${event.payload.scope.id} already exists`);
      return { ...next, scopes: { ...next.scopes, [event.payload.scope.id]: event.payload.scope } };
    case "fork.created": {
      const p = event.payload;
      if (next.forkGroups?.[p.groupId]) throw new Error(`Fork group ${p.groupId} already exists`);
      return {
        ...next,
        forkGroups: {
          ...next.forkGroups,
          [p.groupId]: {
            id: p.groupId,
            scopeId: p.scopeId,
            branchIds: p.branchIds,
            status: "running",
            joined: false,
            branchStatuses: Object.fromEntries(p.branchIds.map((id) => [id, "pending"])),
          },
        },
      };
    }
    case "join.completed": {
      const p = event.payload;
      const group = next.forkGroups?.[p.groupId];
      if (!group) return next;
      return {
        ...next,
        forkGroups: {
          ...next.forkGroups,
          [p.groupId]: {
            ...group,
            status: p.status,
            joined: true,
            branchStatuses: p.branchStatuses ?? group.branchStatuses,
          },
        },
      };
    }
    case "invocation.created":
      return invocationCreated(next, event);
    case "invocation.cancelled": {
      const invocation = next.invocations[event.payload.invocationId];
      if (!invocation) throw new Error(`Unknown invocation ${event.payload.invocationId}`);
      if (!["pending", "reserved", "running"].includes(invocation.status)) return next;
      return {
        ...next,
        invocations: {
          ...next.invocations,
          [invocation.id]: {
            ...invocation,
            status: "failed",
            completedAt: event.recordedAt,
            outcome: "cancelled",
            error: event.payload.reason,
          },
        },
      };
    }
    case "attempt.reserved":
      return attemptReserved(next, event);
    case "attempt.started":
      return attemptStarted(next, event);
    case "attempt.completed":
      return attemptCompleted(next, event);
    case "invocation.completed":
      return invocationCompleted(next, event);
    case "run.completed":
      return runCompleted(next, event);
    case "approval.requested":
      return approvalRequested(next, event);
    case "approval.decided":
      return approvalDecided(next, event);
    case "counter.incremented":
      return counterIncremented(next, event);
    case "recovery.required":
      return recoveryRequired(next, event);
    case "run.paused":
      if (next.status !== "running") throw new Error(`Run cannot pause from ${next.status}`);
      return { ...next, status: "paused" };
    case "run.resumed":
      if (next.status !== "paused") throw new Error(`Run cannot resume from ${next.status}`);
      return { ...next, status: "running" };
    case "run.cancel.requested":
      if (!["running", "paused"].includes(next.status))
        throw new Error(`Run cannot cancel from ${next.status}`);
      return { ...next, control: "cancel-requested" };
    case "run.interrupt.requested":
      if (next.status !== "running") throw new Error(`Run cannot interrupt from ${next.status}`);
      return { ...next, control: "interrupt-requested" };
    case "run.detached":
      return next;
    case "run.retried": {
      const invocation = next.invocations[event.payload.invocationId];
      if (!invocation || invocation.status !== "failed")
        throw new Error("Only a failed terminal invocation can be retried");
      const source = next.attempts[event.payload.sourceAttemptId];
      if (!source || source.invocationId !== invocation.id || source.status !== "failed")
        throw new Error("Retry source attempt is not failed");
      if (next.attempts[event.payload.attemptId]) throw new Error("Retry attempt already exists");
      return {
        ...next,
        invocations: { ...next.invocations, [invocation.id]: { ...invocation, status: "running" } },
      };
    }
    default:
      return assertNever(event);
  }
}

function approvalRequested(
  state: ExecutionState,
  event: Extract<LifecycleEvent, { type: "approval.requested" }>,
): ExecutionState {
  const p = event.payload;
  const invocation = state.invocations[p.invocationId];
  if (!invocation || invocation.status !== "pending")
    throw new Error(`Approval ${p.approvalId} requires a pending invocation`);
  if (state.approvals[p.approvalId]) throw new Error(`Approval ${p.approvalId} already exists`);
  return {
    ...state,
    approvals: {
      ...state.approvals,
      [p.approvalId]: {
        id: p.approvalId,
        invocationId: p.invocationId,
        action: p.action,
        status: "pending",
        bindingDigest: p.bindingDigest,
        subjectRevision: p.subjectRevision,
      },
    },
  };
}

function approvalDecided(
  state: ExecutionState,
  event: Extract<LifecycleEvent, { type: "approval.decided" }>,
): ExecutionState {
  const p = event.payload;
  const approval = state.approvals[p.approvalId];
  if (!approval || approval.status !== "pending")
    throw new Error(`Approval ${p.approvalId} is not pending`);
  if (approval.bindingDigest !== p.bindingDigest || approval.subjectRevision !== p.subjectRevision)
    throw new Error("Approval is stale: action binding or subject revision changed");
  const invocation = state.invocations[approval.invocationId];
  if (!invocation || invocation.status !== "pending")
    throw new Error("Approval subject is no longer pending");
  const status = p.decision === "approved" ? "succeeded" : "failed";
  return {
    ...state,
    approvals: {
      ...state.approvals,
      [approval.id]: {
        ...approval,
        status: p.decision,
        actor: event.actor,
        decidedAt: event.recordedAt,
      },
    },
    invocations: {
      ...state.invocations,
      [invocation.id]: {
        ...invocation,
        status,
        completedAt: event.recordedAt,
        outcome: p.decision,
      },
    },
  };
}

function counterIncremented(
  state: ExecutionState,
  event: Extract<LifecycleEvent, { type: "counter.incremented" }>,
): ExecutionState {
  const key = `${event.payload.scopeId}:${event.payload.counterId}`;
  const current = state.counters[key] ?? 0;
  if (!Number.isSafeInteger(event.payload.value) || event.payload.value !== current + 1)
    throw new Error(`Counter ${key} must increment monotonically by one`);
  return { ...state, counters: { ...state.counters, [key]: event.payload.value } };
}

function runStarted(
  state: ExecutionState,
  event: Extract<LifecycleEvent, { type: "run.started" }>,
): ExecutionState {
  if (state.status !== "pending") throw new Error(`Run cannot start from ${state.status}`);
  const rootScopeId = event.payload.rootScopeId ?? state.rootScopeId;
  const scopes = { ...state.scopes };
  if (rootScopeId !== state.rootScopeId) delete scopes[state.rootScopeId];
  scopes[rootScopeId] = {
    id: rootScopeId,
    parentScopeId: null,
    definitionId:
      event.payload.rootDefinitionId ?? state.scopes[state.rootScopeId]?.definitionId ?? "root",
    status: "running",
    activationOrdinal: 0,
  };
  return { ...state, status: "running", rootScopeId, startedAt: event.recordedAt, scopes };
}

function invocationCreated(
  state: ExecutionState,
  event: Extract<LifecycleEvent, { type: "invocation.created" }>,
): ExecutionState {
  const payload = event.payload;
  if (state.invocations[payload.invocationId])
    throw new Error(`Invocation ${payload.invocationId} already exists`);
  const scopeId = payload.scopeId ?? state.rootScopeId;
  if (!state.scopes[scopeId])
    throw new Error(`Cannot create invocation in unknown scope ${scopeId}`);
  const invocation: InvocationState = {
    id: payload.invocationId,
    scopeId,
    nodeId: payload.nodeId,
    activationOrdinal: payload.activationOrdinal ?? Object.keys(state.invocations).length,
    ...(payload.repairPass === undefined ? {} : { repairPass: payload.repairPass }),
    ...(payload.sourceInvocationId ? { sourceInvocationId: payload.sourceInvocationId } : {}),
    ...(payload.sourceEdgeId ? { sourceEdgeId: payload.sourceEdgeId } : {}),
    status: "pending",
    inputBindings: payload.inputBindings ?? {},
    output: [],
    evidence: [],
    artifacts: [],
    workspace: null,
    createdAt: event.recordedAt,
    startedAt: null,
    completedAt: null,
    outcome: null,
  };
  return {
    ...state,
    invocations: { ...state.invocations, [invocation.id]: invocation },
  };
}

function attemptReserved(
  state: ExecutionState,
  event: Extract<LifecycleEvent, { type: "attempt.reserved" }>,
): ExecutionState {
  const payload = event.payload;
  const invocation = state.invocations[payload.invocationId];
  if (!invocation)
    throw new Error(`Cannot reserve attempt for unknown invocation ${payload.invocationId}`);
  if (state.attempts[payload.attemptId])
    throw new Error(`Attempt ${payload.attemptId} already exists`);
  const priorAttempts = Object.values(state.attempts).filter(
    (item) => item.invocationId === invocation.id,
  );
  const latest = [...priorAttempts].sort((left, right) => right.ordinal - left.ordinal)[0];
  const retrying = invocation.status === "running" && latest?.status === "failed";
  if (invocation.status !== "pending" && !retrying)
    throw new Error(`Invocation ${invocation.id} is not reservable from ${invocation.status}`);
  const attempt: AttemptState = {
    id: payload.attemptId,
    invocationId: payload.invocationId,
    ordinal: payload.ordinal ?? priorAttempts.length,
    status: "reserved",
    startedAt: null,
    finishedAt: null,
    output: [],
    evidence: [],
    artifacts: [],
    workspace: null,
  };
  return {
    ...state,
    attempts: { ...state.attempts, [attempt.id]: attempt },
    invocations: { ...state.invocations, [invocation.id]: { ...invocation, status: "reserved" } },
  };
}

function attemptStarted(
  state: ExecutionState,
  event: Extract<LifecycleEvent, { type: "attempt.started" }>,
): ExecutionState {
  const attempt = state.attempts[event.payload.attemptId];
  if (!attempt) throw new Error(`Cannot start unknown attempt ${event.payload.attemptId}`);
  if (attempt.status !== "reserved")
    throw new Error(`Attempt ${attempt.id} is not reservable from ${attempt.status}`);
  const invocation = state.invocations[attempt.invocationId];
  if (!invocation)
    throw new Error(`Attempt ${attempt.id} references unknown invocation ${attempt.invocationId}`);
  return {
    ...state,
    attempts: {
      ...state.attempts,
      [attempt.id]: { ...attempt, status: "running", startedAt: event.recordedAt },
    },
    invocations: {
      ...state.invocations,
      [invocation.id]: { ...invocation, status: "running", startedAt: event.recordedAt },
    },
  };
}

function attemptCompleted(
  state: ExecutionState,
  event: Extract<LifecycleEvent, { type: "attempt.completed" }>,
): ExecutionState {
  const payload = event.payload;
  const attempt = state.attempts[payload.attemptId];
  if (!attempt) throw new Error(`Cannot complete unknown attempt ${payload.attemptId}`);
  if (attempt.status !== "running") {
    throw new Error(`Attempt ${attempt.id} is not active (${attempt.status})`);
  }
  const completed: AttemptState = {
    ...attempt,
    status: payload.status,
    finishedAt: event.recordedAt,
    output: payload.output ?? [],
    evidence: payload.evidence ?? [],
    artifacts: payload.artifacts ?? [],
    workspace: payload.workspace ?? null,
    ...(payload.commandEvidence === undefined ? {} : { commandEvidence: payload.commandEvidence }),
    ...(payload.error === undefined ? {} : { error: payload.error }),
    ...(payload.resolvedExecution === undefined
      ? {}
      : { resolvedExecution: payload.resolvedExecution }),
    ...(payload.contextManifest === undefined ? {} : { contextManifest: payload.contextManifest }),
    ...(payload.harnessEvents === undefined ? {} : { harnessEvents: payload.harnessEvents }),
    ...(payload.usage === undefined ? {} : { usage: payload.usage }),
    ...(payload.diagnostics === undefined ? {} : { diagnostics: payload.diagnostics }),
    ...(payload.sessionReference === undefined
      ? {}
      : { sessionReference: payload.sessionReference }),
  };
  if (attempt.startedAt && compareTime(event.recordedAt, attempt.startedAt) < 0) {
    throw new Error(`Attempt ${attempt.id} finished before it started`);
  }
  return { ...state, attempts: { ...state.attempts, [attempt.id]: completed } };
}

function invocationCompleted(
  state: ExecutionState,
  event: Extract<LifecycleEvent, { type: "invocation.completed" }>,
): ExecutionState {
  const payload = event.payload;
  const invocation = state.invocations[payload.invocationId];
  if (!invocation) throw new Error(`Cannot complete unknown invocation ${payload.invocationId}`);
  // A fail-fast join may cancel an in-flight invocation before its harness
  // returns. The harness result is still journaled for attempt/effect
  // recovery, but must not overwrite the durable cancellation decision.
  if (invocation.status === "failed" && invocation.outcome === "cancelled") return state;
  if (
    invocation.status !== "running" &&
    !(payload.direct === true && invocation.status === "pending")
  ) {
    throw new Error(`Invocation ${invocation.id} is not completable from ${invocation.status}`);
  }
  const attempts = Object.values(state.attempts).filter(
    (attempt) => attempt.invocationId === invocation.id,
  );
  if (payload.status === "succeeded" && attempts.length === 0 && payload.direct !== true) {
    throw new Error(
      `Invocation ${invocation.id} requires a completed attempt unless it is a direct complete node`,
    );
  }
  if (
    attempts.length > 0 &&
    attempts.every((attempt) => attempt.status === "running" || attempt.status === "reserved")
  ) {
    throw new Error(`Invocation ${invocation.id} cannot complete while its attempts are active`);
  }
  const latest = [...attempts].sort((left, right) => right.ordinal - left.ordinal)[0];
  if (latest && latest.status !== payload.status) {
    throw new Error(
      `Invocation ${invocation.id} status ${payload.status} does not match latest attempt ${latest.status}`,
    );
  }
  if (invocation.startedAt && compareTime(event.recordedAt, invocation.startedAt) < 0) {
    throw new Error(`Invocation ${invocation.id} completed before it started`);
  }
  const completed: InvocationState = {
    ...invocation,
    status: payload.status,
    completedAt: event.recordedAt,
    outcome: payload.outcome ?? (payload.status === "succeeded" ? "success" : "failure"),
    output: payload.output ?? invocation.output,
    evidence: payload.evidence ?? invocation.evidence,
    artifacts: payload.artifacts ?? invocation.artifacts,
    workspace: payload.workspace === undefined ? invocation.workspace : payload.workspace,
    ...(payload.error === undefined ? {} : { error: payload.error }),
  };
  return { ...state, invocations: { ...state.invocations, [invocation.id]: completed } };
}

function runCompleted(
  state: ExecutionState,
  event: Extract<LifecycleEvent, { type: "run.completed" }>,
): ExecutionState {
  if (state.status !== "running" && state.status !== "paused")
    throw new Error(`Run cannot complete from ${state.status}`);
  const invocations = Object.values(state.invocations);
  if (
    invocations.length === 0 ||
    invocations.some(
      (invocation) => !["succeeded", "failed", "recovery-required"].includes(invocation.status),
    )
  ) {
    throw new Error("Run cannot complete while invocations are absent or active");
  }
  if (
    event.payload.status === "succeeded" &&
    invocations.some((invocation) => invocation.status !== "succeeded")
  ) {
    throw new Error("Run cannot succeed with a non-succeeded invocation");
  }
  if (state.startedAt && compareTime(event.recordedAt, state.startedAt) < 0)
    throw new Error("Run completed before it started");
  const scopes = { ...state.scopes };
  const root = scopes[state.rootScopeId];
  if (root) scopes[root.id] = { ...root, status: event.payload.status };
  return { ...state, status: event.payload.status, finishedAt: event.recordedAt, scopes };
}

function recoveryRequired(
  state: ExecutionState,
  event: Extract<LifecycleEvent, { type: "recovery.required" }>,
): ExecutionState {
  return {
    ...state,
    status: "recovery-required",
    recovery: {
      code: event.payload.code,
      subjectId: event.payload.subjectId ?? null,
      ...(event.payload.detail === undefined ? {} : { detail: event.payload.detail }),
    },
  };
}

/**
 * Pure readiness decisions for the M1 sequential graph. IDs, timestamps and
 * external observations remain host responsibilities. Unsupported future node
 * kinds never produce an execute intent.
 */
export function decide(bundle: Bundle, state: ExecutionState): readonly DecisionIntent[] {
  if (state.status !== "running") return [];
  if ((state.control ?? "none") !== "none") return [];
  const definition = bundle.definitions[bundle.rootDefinitionId];
  if (!definition) return [];
  const intents: DecisionIntent[] = [];
  const activeScope = state.scopes[state.rootScopeId];
  if (!activeScope) return [];

  if (Object.keys(state.invocations).length === 0) {
    if (definition.entry) {
      const entry = definition.nodes.find((node) => node.id === definition.entry);
      intents.push({
        kind: "activate",
        scopeId: state.rootScopeId,
        nodeId: definition.entry,
        bindings: entry ? bindingsForNode(entry, state, state.rootScopeId) : {},
      });
    }
    return intents;
  }

  const invocations = Object.values(state.invocations).sort(
    (a, b) => a.activationOrdinal - b.activationOrdinal || a.id.localeCompare(b.id),
  );
  for (const invocation of invocations) {
    const scopeDefinition =
      bundle.definitions[
        state.scopes[invocation.scopeId]?.definitionId ?? bundle.rootDefinitionId
      ] ?? definition;
    const node = scopeDefinition.nodes.find((candidate) => candidate.id === invocation.nodeId);
    if (invocation.status === "pending") {
      if (node?.kind === "approval") {
        const approval = Object.values(state.approvals).find(
          (item) => item.invocationId === invocation.id,
        );
        if (!approval) {
          intents.push({
            kind: "request-approval",
            invocationId: invocation.id,
            action: node.action,
            bindingDigest: digestBindings(invocation.inputBindings),
            subjectRevision: state.revision,
          });
        }
        continue;
      }
      if (node?.kind === "complete") {
        intents.push({ kind: "complete", invocationId: invocation.id, outcome: node.result });
        continue;
      }
      if (node?.kind === "call") {
        const childScope = Object.values(state.scopes).find(
          (scope) =>
            scope.parentScopeId === invocation.scopeId && scope.id === `${invocation.id}:scope`,
        );
        if (!childScope) {
          intents.push({
            kind: "call",
            invocationId: invocation.id,
            definitionId: (node as CallNode).definitionId,
            scopeId: invocation.scopeId,
          });
        } else {
          const childInvocations = Object.values(state.invocations).filter(
            (candidate) => candidate.scopeId === childScope.id,
          );
          if (
            childInvocations.length > 0 &&
            childInvocations.every((candidate) =>
              ["succeeded", "failed", "recovery-required"].includes(candidate.status),
            )
          ) {
            const output = childInvocations.flatMap((candidate) => candidate.output);
            const evidence = childInvocations.flatMap((candidate) => candidate.evidence);
            const artifacts = childInvocations.flatMap((candidate) => candidate.artifacts);
            intents.push({
              kind: "complete",
              invocationId: invocation.id,
              outcome: childInvocations.some((candidate) => candidate.status !== "succeeded")
                ? "failed"
                : "succeeded",
              output,
              evidence,
              artifacts,
            });
          }
        }
        continue;
      }
      if (node?.kind === "loop") {
        const loopNode = node as import("./contracts").LoopNode;
        const iterations = Object.values(state.scopes)
          .filter(
            (scope) =>
              scope.parentScopeId === invocation.scopeId &&
              scope.id.startsWith(`${invocation.id}:iteration:`),
          )
          .sort((left, right) => left.activationOrdinal - right.activationOrdinal);
        const latest = iterations.at(-1);
        const latestInvocations = latest
          ? Object.values(state.invocations).filter((candidate) => candidate.scopeId === latest.id)
          : [];
        if (
          !latest ||
          latestInvocations.every((candidate) =>
            ["succeeded", "failed", "recovery-required"].includes(candidate.status),
          )
        ) {
          const failed = latestInvocations.some((candidate) => candidate.status !== "succeeded");
          if (failed || iterations.length >= loopNode.maxIterations) {
            intents.push({
              kind: "complete",
              invocationId: invocation.id,
              outcome: failed ? "failed" : "succeeded",
              output: latestInvocations.flatMap((candidate) => candidate.output),
              evidence: latestInvocations.flatMap((candidate) => candidate.evidence),
              artifacts: latestInvocations.flatMap((candidate) => candidate.artifacts),
            });
          } else {
            intents.push({
              kind: "loop",
              invocationId: invocation.id,
              scopeId: invocation.scopeId,
              bodyNodeId: loopNode.bodyNodeId,
              iteration: iterations.length + 1,
            });
          }
        }
        continue;
      }
      if (node?.kind === "forEach") {
        const mapNode = node as import("./contracts").ForEachNode;
        const raw = invocation.inputBindings[mapNode.collection.targetPort]?.value;
        const collection = Array.isArray(raw) ? raw : [];
        if (collection.length > mapNode.maxItems) {
          intents.push({ kind: "complete", invocationId: invocation.id, outcome: "failed" });
          continue;
        }
        const items = collection.slice(0, mapNode.maxItems);
        const itemScopes = Object.values(state.scopes)
          .filter(
            (scope) =>
              scope.parentScopeId === invocation.scopeId &&
              scope.id.startsWith(`${invocation.id}:item:`),
          )
          .sort((left, right) => left.activationOrdinal - right.activationOrdinal);
        const completed = itemScopes.every((scope) =>
          Object.values(state.invocations)
            .filter((candidate) => candidate.scopeId === scope.id)
            .every((candidate) =>
              ["succeeded", "failed", "recovery-required"].includes(candidate.status),
            ),
        );
        if (itemScopes.length >= items.length && completed) {
          const children = itemScopes.flatMap((scope) =>
            Object.values(state.invocations)
              .filter((candidate) => candidate.scopeId === scope.id)
              .sort((a, b) => a.activationOrdinal - b.activationOrdinal),
          );
          intents.push({
            kind: "complete",
            invocationId: invocation.id,
            outcome: children.some((candidate) => candidate.status !== "succeeded")
              ? "failed"
              : "succeeded",
            output: children.flatMap((candidate) => candidate.output),
            evidence: children.flatMap((candidate) => candidate.evidence),
            artifacts: children.flatMap((candidate) => candidate.artifacts),
          });
        } else if (itemScopes.length < items.length) {
          const definitionId = (node as import("./contracts").ForEachNode).templateDefinitionId;
          for (let itemIndex = itemScopes.length; itemIndex < items.length; itemIndex += 1)
            intents.push({
              kind: "forEach",
              invocationId: invocation.id,
              scopeId: invocation.scopeId,
              definitionId,
              itemIndex,
              item: items[itemIndex]!,
            });
        }
        continue;
      }
      // Structural nodes are durable graph activations, not effects.  A fork
      // completes immediately; its declared branches are then activated from
      // the same invocation lineage.  A join is a barrier and is only
      // completed after its branch invocations have settled.
      if (node?.kind === "fork") {
        intents.push({ kind: "complete", invocationId: invocation.id, outcome: "succeeded" });
        continue;
      }
      if (node?.kind === "join") {
        const joinNode = node as JoinNode;
        const fork = scopeDefinition.nodes.find(
          (candidate) =>
            candidate.kind === "fork" && (candidate as ForkNode).groupId === joinNode.groupId,
        );
        const branches = fork?.kind === "fork" ? (fork as ForkNode).branchIds : [];
        const branchInvocations = Object.values(state.invocations).filter(
          (candidate) =>
            candidate.scopeId === invocation.scopeId && branches.includes(candidate.nodeId),
        );
        if (
          joinNode.mode === "fail-fast" &&
          branchInvocations.some((candidate) => candidate.status === "failed")
        ) {
          intents.push({
            kind: "complete",
            invocationId: invocation.id,
            outcome: "failed",
            output: branches.flatMap(
              (branchId) =>
                branchInvocations.find((candidate) => candidate.nodeId === branchId)?.output ?? [],
            ),
          });
          continue;
        }
        if (
          branches.length > 0 &&
          branchInvocations.length >= branches.length &&
          branchInvocations.every((candidate) => ["succeeded", "failed"].includes(candidate.status))
        ) {
          const failed = branchInvocations.some((candidate) => candidate.status === "failed");
          if (joinNode.mode === "fail-fast" && failed) {
            intents.push({
              kind: "complete",
              invocationId: invocation.id,
              outcome: "failed",
              output: branches.flatMap(
                (branchId) =>
                  branchInvocations.find((candidate) => candidate.nodeId === branchId)?.output ??
                  [],
              ),
            });
          } else {
            intents.push({
              kind: "complete",
              invocationId: invocation.id,
              outcome: failed ? "failed" : "succeeded",
              output: branches.flatMap(
                (branchId) =>
                  branchInvocations.find((candidate) => candidate.nodeId === branchId)?.output ??
                  [],
              ),
            });
          }
        }
        continue;
      }
      const attempts = Object.values(state.attempts).filter(
        (attempt) => attempt.invocationId === invocation.id,
      );
      intents.push({
        kind: "reserve",
        invocationId: invocation.id,
        attemptOrdinal: attempts.length,
      });
      continue;
    }
    if (invocation.status === "reserved") {
      const attempt = latestAttempt(state, invocation.id);
      if (attempt)
        intents.push({ kind: "execute", invocationId: invocation.id, attemptId: attempt.id });
      continue;
    }
    if (invocation.status === "running") continue;
    if (invocation.status === "succeeded") {
      const node = scopeDefinition.nodes.find((candidate) => candidate.id === invocation.nodeId);
      if (node?.kind === "complete" && invocation.scopeId === state.rootScopeId) {
        intents.push({ kind: "finish", status: node.result });
        return intents;
      }
      if (node?.kind === "fork") {
        const forkNode = node as ForkNode;
        for (const branchId of forkNode.branchIds) {
          const target = scopeDefinition.nodes.find((candidate) => candidate.id === branchId);
          if (!target) continue;
          const alreadyActivated = Object.values(state.invocations).some(
            (candidate) =>
              candidate.sourceInvocationId === invocation.id && candidate.nodeId === branchId,
          );
          if (!alreadyActivated)
            intents.push({
              kind: "activate",
              scopeId: invocation.scopeId,
              nodeId: branchId,
              bindings: bindingsForNode(target, state, invocation.scopeId, invocation.id),
              sourceInvocationId: invocation.id,
              sourceEdgeId: `${node.id}:branch:${branchId}`,
            });
        }
        const branchInvocations = Object.values(state.invocations).filter(
          (candidate) =>
            candidate.scopeId === invocation.scopeId &&
            forkNode.branchIds.includes(candidate.nodeId),
        );
        const joinNode = scopeDefinition.nodes.find(
          (candidate) =>
            candidate.kind === "join" && (candidate as JoinNode).groupId === forkNode.groupId,
        ) as JoinNode | undefined;
        const failFastReady =
          joinNode?.mode === "fail-fast" &&
          branchInvocations.some((candidate) => candidate.status === "failed");
        if (
          failFastReady ||
          (branchInvocations.length >= forkNode.branchIds.length &&
            branchInvocations.every((candidate) =>
              ["succeeded", "failed"].includes(candidate.status),
            ))
        ) {
          for (const join of scopeDefinition.nodes.filter(
            (candidate): candidate is Extract<typeof candidate, { kind: "join" }> =>
              candidate.kind === "join" && (candidate as JoinNode).groupId === forkNode.groupId,
          )) {
            const alreadyActivated = Object.values(state.invocations).some(
              (candidate) =>
                candidate.nodeId === join.id && candidate.sourceInvocationId === invocation.id,
            );
            if (!alreadyActivated)
              intents.push({
                kind: "activate",
                scopeId: invocation.scopeId,
                nodeId: join.id,
                bindings: bindingsForNode(join, state, invocation.scopeId, invocation.id),
                sourceInvocationId: invocation.id,
                sourceEdgeId: `${node.id}:join:${join.id}`,
              });
          }
        }
        continue;
      }
      const outgoing = scopeDefinition.controlEdges.filter(
        (edge) =>
          edge.sourceNodeId === invocation.nodeId &&
          edge.outcome === (invocation.outcome ?? "success"),
      );
      for (const edge of selectEdges(outgoing, state, invocation.scopeId, bundle)) {
        // Join barriers are activated by the barrier itself once all declared
        // branches settle.  Do not create one join invocation per branch.
        const targetNode = scopeDefinition.nodes.find(
          (candidate) => candidate.id === edge.targetNodeId,
        );
        if (targetNode?.kind === "join") continue;
        const alreadyActivated = Object.values(state.invocations).some(
          (candidate) =>
            candidate.sourceInvocationId === invocation.id && candidate.sourceEdgeId === edge.id,
        );
        if (alreadyActivated) continue;
        const target = scopeDefinition.nodes.find(
          (candidate) => candidate.id === edge.targetNodeId,
        );
        if (target)
          intents.push({
            kind: "activate",
            scopeId: invocation.scopeId,
            nodeId: edge.targetNodeId,
            bindings: bindingsForEdge(target, edge, invocation, state),
            sourceEdgeId: edge.id,
            sourceInvocationId: invocation.id,
            ...(edge.counterIncrement ? { counterId: edge.counterIncrement } : {}),
            ...(edge.counterIncrement
              ? {
                  repairPass:
                    (state.counters[`${invocation.scopeId}:${edge.counterIncrement}`] ?? 0) + 1,
                }
              : {}),
          });
      }
      continue;
    }
    if (invocation.status === "failed") {
      const outgoing = scopeDefinition.controlEdges.filter(
        (edge) => edge.sourceNodeId === invocation.nodeId && edge.outcome === "failure",
      );
      const owningFork = scopeDefinition.nodes.find(
        (candidate) =>
          candidate.kind === "fork" &&
          (candidate as ForkNode).branchIds.includes(invocation.nodeId),
      ) as ForkNode | undefined;
      if (outgoing.length === 0) {
        // A failed fork branch is evidence for its join, not a terminal run.
        // The fork's structural activation will admit the join (including
        // fail-fast joins) once this fact is durable.
        if (owningFork) continue;
        intents.push({ kind: "finish", status: "failed" });
        return intents;
      }
      for (const edge of selectEdges(outgoing, state, invocation.scopeId, bundle)) {
        const targetNode = scopeDefinition.nodes.find(
          (candidate) => candidate.id === edge.targetNodeId,
        );
        if (targetNode?.kind === "join") continue;
        const alreadyActivated = Object.values(state.invocations).some(
          (candidate) =>
            candidate.sourceInvocationId === invocation.id && candidate.sourceEdgeId === edge.id,
        );
        if (alreadyActivated) continue;
        const target = scopeDefinition.nodes.find(
          (candidate) => candidate.id === edge.targetNodeId,
        );
        if (target)
          intents.push({
            kind: "activate",
            scopeId: invocation.scopeId,
            nodeId: edge.targetNodeId,
            bindings: bindingsForEdge(target, edge, invocation, state),
            sourceEdgeId: edge.id,
            sourceInvocationId: invocation.id,
            ...(edge.counterIncrement ? { counterId: edge.counterIncrement } : {}),
            ...(edge.counterIncrement
              ? {
                  repairPass:
                    (state.counters[`${invocation.scopeId}:${edge.counterIncrement}`] ?? 0) + 1,
                }
              : {}),
          });
      }
    }
  }
  const rootInvocations = invocations.filter(
    (invocation) => invocation.scopeId === state.rootScopeId,
  );
  if (
    rootInvocations.length > 0 &&
    rootInvocations.every(
      (invocation) => invocation.status === "succeeded" || invocation.status === "failed",
    )
  ) {
    const last = rootInvocations[rootInvocations.length - 1]!;
    const node = definition.nodes.find((candidate) => candidate.id === last.nodeId);
    if (
      node?.kind !== "complete" &&
      !definition.controlEdges.some((edge) => edge.sourceNodeId === last.nodeId)
    ) {
      intents.push({
        kind: "finish",
        status: last.status === "succeeded" ? "succeeded" : "failed",
      });
    }
  }
  return deduplicateIntents(intents);
}

function latestAttempt(state: ExecutionState, invocationId: string): AttemptState | undefined {
  return Object.values(state.attempts)
    .filter((attempt) => attempt.invocationId === invocationId)
    .sort((a, b) => b.ordinal - a.ordinal || b.id.localeCompare(a.id))[0];
}

function bindingsForNode(
  node: WorkflowNode,
  state: ExecutionState,
  consumerScopeId: string,
  consumerInvocationId?: string,
): Readonly<Record<string, BoundInput>> {
  const result: Record<string, BoundInput> = {};
  for (const binding of node.bindings) {
    const source = binding.source;
    const producer =
      source.kind === "producer"
        ? latestScopedProducer(state, source.sourceId, consumerScopeId, consumerInvocationId)
        : undefined;
    const bound: BoundInput = {
      source: binding.source,
      ...(binding.path === undefined ? {} : { path: binding.path }),
      missing: binding.missing,
      ...(binding.source.kind === "literal" ? { value: binding.source.value } : {}),
      ...(binding.source.kind === "producer" &&
      producer &&
      binding.source.sourceId === producer.nodeId &&
      producer.output[0]
        ? { artifactId: producer.output[0].id }
        : {}),
    };
    result[binding.targetPort] = bound;
  }
  return result;
}

/** Resolve an edge's feedback against the invocation that emitted the outcome.
 * This intentionally accepts failed producers: validation output is evidence
 * even when the validator failed, and must be available to the repair pass.
 */
function bindingsForEdge(
  node: WorkflowNode,
  edge: import("./contracts").ControlEdge,
  sourceInvocation: import("./contracts").InvocationState,
  state: ExecutionState,
): Readonly<Record<string, BoundInput>> {
  const result = {
    ...bindingsForNode(node, state, sourceInvocation.scopeId, sourceInvocation.id),
  };
  for (const binding of edge.feedbackBindings ?? []) {
    const producer =
      binding.source.kind === "producer" && binding.source.sourceId === sourceInvocation.nodeId
        ? sourceInvocation
        : undefined;
    result[binding.targetPort] = boundInput(binding, producer);
  }
  return result;
}

function latestScopedProducer(
  state: ExecutionState,
  sourceNodeId: string,
  consumerScopeId: string,
  consumerInvocationId?: string,
): import("./contracts").InvocationState | undefined {
  const lineage = consumerInvocationId
    ? invocationLineage(state, consumerInvocationId)
    : new Set<string>();
  const consumer = consumerInvocationId ? state.invocations[consumerInvocationId] : undefined;
  const boundProducerArtifacts = new Set(
    Object.values(consumer?.inputBindings ?? {})
      .filter(
        (binding) => binding.source.kind === "producer" && binding.source.sourceId === sourceNodeId,
      )
      .flatMap((binding) => (binding.artifactId ? [binding.artifactId] : [])),
  );
  return Object.values(state.invocations)
    .filter(
      (candidate) =>
        candidate.scopeId === consumerScopeId &&
        candidate.nodeId === sourceNodeId &&
        candidate.status === "succeeded" &&
        (lineage.has(candidate.id) ||
          (candidate.sourceInvocationId !== undefined &&
            lineage.has(candidate.sourceInvocationId)) ||
          candidate.output.some((artifact) => boundProducerArtifacts.has(artifact.id))),
    )
    .sort(
      (left, right) =>
        right.activationOrdinal - left.activationOrdinal || right.id.localeCompare(left.id),
    )[0];
}

function invocationLineage(state: ExecutionState, invocationId: string): Set<string> {
  const lineage = new Set<string>();
  let current: import("./contracts").InvocationState | undefined = state.invocations[invocationId];
  while (current && !lineage.has(current.id)) {
    lineage.add(current.id);
    if (!current.sourceInvocationId) break;
    // Materialized checkpoint prefixes retain source invocation IDs as
    // external lineage tokens. Keep the token even when its parent envelope
    // is intentionally absent from the child run.
    lineage.add(current.sourceInvocationId);
    current = state.invocations[current.sourceInvocationId];
  }
  return lineage;
}

function boundInput(
  binding: import("./contracts").Binding,
  producer: import("./contracts").InvocationState | undefined,
): BoundInput {
  return {
    source: binding.source,
    ...(binding.path === undefined ? {} : { path: binding.path }),
    missing: binding.missing,
    ...(binding.source.kind === "literal" ? { value: binding.source.value } : {}),
    ...(producer?.output[0] ? { artifactId: producer.output[0].id } : {}),
  };
}

function deduplicateIntents(intents: readonly DecisionIntent[]): readonly DecisionIntent[] {
  const seen = new Set<string>();
  return intents.filter((intent) => {
    const key = JSON.stringify(intent);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function guardAllows(
  guard: import("./contracts").JsonValue | undefined,
  state: ExecutionState,
  scopeId: string,
  bundle: Bundle,
): boolean {
  if (guard === undefined) return true;
  if (!guard || typeof guard !== "object" || Array.isArray(guard)) return false;
  const value = guard as Record<string, unknown>;
  if (value.kind !== "counter-below-limit" || typeof value.counterId !== "string") return false;
  // The compiler guarantees the counter exists; runtime treats absent state as zero.
  const definition = value.counterId;
  const current = state.counters[`${scopeId}:${definition}`] ?? 0;
  const max = bundle.definitions[bundle.rootDefinitionId]?.counters.find(
    (counter) => counter.id === definition,
  )?.max;
  return max === undefined ? false : current < max;
}

function selectEdges(
  edges: readonly import("./contracts").ControlEdge[],
  state: ExecutionState,
  scopeId: string,
  bundle: Bundle,
): readonly import("./contracts").ControlEdge[] {
  const guarded = edges.filter(
    (edge) => !edge.default && guardAllows(edge.guard, state, scopeId, bundle),
  );
  if (guarded.length) return guarded;
  return edges.filter((edge) => edge.default === true || edge.guard === undefined);
}

function digestBindings(
  bindings: Readonly<Record<string, import("./contracts").BoundInput>>,
): string {
  return JSON.stringify(
    Object.keys(bindings)
      .sort()
      .map((key) => [key, bindings[key]]),
  );
}

function assertNever(value: never): never {
  throw new Error(`Unknown lifecycle event ${(value as { type?: string }).type ?? "?"}`);
}

function compareTime(left: string, right: string): number {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (Number.isFinite(leftMs) && Number.isFinite(rightMs)) return leftMs - rightMs;
  return left.localeCompare(right);
}
