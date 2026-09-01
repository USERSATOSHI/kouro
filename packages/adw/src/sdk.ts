import type {
  AgentContextSource,
  AgentReasoningEffort,
  Expression,
  JsonPrimitive,
  JsonValue,
  RecoveryPolicy as DomainRecoveryPolicy,
  SourceTransition,
} from '@kouro/domain';

/** Built-in workflow capabilities understood by Kouro's execution boundary. */
export const CAPABILITY = Object.freeze({
  REPOSITORY_READ: 'repository.read',
  REPOSITORY_WRITE: 'repository.write',
  TERMINAL_EXECUTE: 'terminal.execute',
  NETWORK_ACCESS: 'network.access',
} as const);

export type Capability = (typeof CAPABILITY)[keyof typeof CAPABILITY];

/** Supported side-effect recovery classifications. */
export const RECOVERY_POLICY = Object.freeze({
  REPLAY_SAFE: 'replay_safe',
  VERIFY_THEN_REPLAY: 'verify_then_replay',
  RESUME_SUPPORTED: 'resume_supported',
  MANUAL_RECONCILIATION: 'manual_reconciliation',
  NEVER_AUTOMATICALLY_RETRY: 'never_automatically_retry',
} as const satisfies Readonly<Record<string, DomainRecoveryPolicy>>);

export type RecoveryPolicy = (typeof RECOVERY_POLICY)[keyof typeof RECOVERY_POLICY];

/** Harness IDs provided by Kouro's local composition. */
export const HARNESS = Object.freeze({
  CLAUDE_CODE: 'claude-code',
  CODEX: 'codex',
  OPENCODE: 'opencode',
  PI: 'pi',
} as const);

export type HarnessId = (typeof HARNESS)[keyof typeof HARNESS];

/** Portable reasoning efforts supported by every built-in harness. */
export const REASONING_EFFORT = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
} as const satisfies Readonly<Record<string, AgentReasoningEffort>>);

export type ReasoningEffort = (typeof REASONING_EFFORT)[keyof typeof REASONING_EFFORT];

/**
 * Capability vocabulary accepted by each built-in harness.
 *
 * The entries currently share Kouro's normalized capability language. Keeping
 * the relationship explicit lets a future harness narrow its accepted
 * capabilities without weakening every agent declaration.
 */
export interface HarnessCapabilityMap {
  readonly 'claude-code': Capability;
  readonly codex: Capability;
  readonly opencode: Capability;
  readonly pi: Capability;
}

/** Model identifier syntax accepted by each built-in harness. */
export interface HarnessModelMap {
  readonly 'claude-code': string;
  readonly codex: string;
  readonly opencode: `${string}/${string}`;
  readonly pi: string;
}

export type HarnessModels<Harness extends HarnessId = HarnessId> = Readonly<
  Partial<Pick<HarnessModelMap, Harness>>
>;

interface AgentNodeAuthoringBase<Harness extends HarnessId> {
  readonly type: 'agent';
  readonly role: string;
  readonly prompt: string;
  readonly outputSchema?: string;
  readonly clearContext?: boolean;
  readonly reasoningEffort?: ReasoningEffort;
  readonly allowedSubagents?: readonly string[];
  readonly contextSources?: readonly AgentContextSource[];
  readonly capabilities?: readonly HarnessCapabilityMap[Harness][];
  readonly priority?: number;
  readonly recoveryPolicy: RecoveryPolicy;
  readonly skipOutcome?: string;
}

export interface PortableAgentNodeAuthoring extends AgentNodeAuthoringBase<HarnessId> {
  readonly harness?: never;
  readonly models?: HarnessModels;
}

export type PinnedAgentNodeAuthoring = {
  readonly [Harness in HarnessId]: AgentNodeAuthoringBase<Harness> & {
    readonly harness: Harness;
    readonly models?: HarnessModels<Harness>;
  };
}[HarnessId];

export type AgentNodeAuthoring = PortableAgentNodeAuthoring | PinnedAgentNodeAuthoring;

interface SubagentAuthoringBase {
  readonly role: string;
  readonly prompt: string;
  readonly outputSchema?: string;
  readonly reasoningEffort?: ReasoningEffort;
  readonly capabilities: readonly [typeof CAPABILITY.REPOSITORY_READ];
  readonly maxInvocations: number;
  readonly maxConcurrent: number;
}

export interface PortableSubagentAuthoring extends SubagentAuthoringBase {
  readonly harness?: never;
  readonly models?: HarnessModels;
}

export type PinnedSubagentAuthoring = {
  readonly [Harness in HarnessId]: SubagentAuthoringBase & {
    readonly harness: Harness;
    readonly models?: HarnessModels<Harness>;
  };
}[HarnessId];

export type SubagentAuthoring = PortableSubagentAuthoring | PinnedSubagentAuthoring;

export interface ApprovalNodeAuthoring {
  readonly type: 'approval';
  readonly title: string;
  readonly priority?: number;
  readonly skipOutcome?: string;
}

export interface DeliveryReviewNodeAuthoring {
  readonly type: 'delivery_review';
  readonly title: string;
  readonly proposalFrom: string;
  readonly priority?: number;
}

export interface CommandNodeAuthoring {
  readonly type: 'command';
  readonly command: string;
  readonly capabilities?: readonly Capability[];
  readonly priority?: number;
  readonly recoveryPolicy: RecoveryPolicy;
  readonly skipOutcome?: string;
}

export interface CompleteNodeAuthoring {
  readonly type: 'complete';
  readonly priority?: number;
  readonly result?: 'succeeded' | 'failed';
}

export interface CallNodeAuthoring {
  readonly type: 'call';
  readonly workflow: string;
  readonly priority?: number;
}

export interface ParallelNodeAuthoring {
  readonly type: 'parallel';
  readonly branches: Readonly<Record<string, string>>;
  readonly maxConcurrent: number;
  readonly workspace: 'isolated';
  readonly join: 'disjoint';
  readonly priority?: number;
}

export interface ForEachNodeAuthoring {
  readonly type: 'for_each';
  readonly workflow: string;
  readonly itemsFrom: {
    readonly node: NodeHandle | string;
    readonly path: readonly string[];
  };
  readonly maxItems: number;
  readonly maxConcurrent: number;
  readonly workspace: 'isolated';
  readonly join: 'disjoint';
  readonly priority?: number;
}

export interface SleepNodeAuthoring {
  readonly type: 'sleep';
  readonly durationMs: number;
  readonly priority?: number;
}

export interface WaitForEventNodeAuthoring {
  readonly type: 'wait_for_event';
  readonly event: string;
  readonly payloadSchema?: string;
  readonly timeoutMs?: number;
  readonly priority?: number;
}

export type NodeAuthoring =
  | AgentNodeAuthoring
  | ApprovalNodeAuthoring
  | DeliveryReviewNodeAuthoring
  | CommandNodeAuthoring
  | CompleteNodeAuthoring
  | CallNodeAuthoring
  | ParallelNodeAuthoring
  | ForEachNodeAuthoring
  | SleepNodeAuthoring
  | WaitForEventNodeAuthoring;

export interface WorkflowAuthoringDefinition {
  readonly id: string;
  readonly version: string;
  readonly entry: string;
  readonly nodes: Readonly<Record<string, NodeAuthoring>>;
  readonly transitions: readonly SourceTransition[];
  readonly permissions?: readonly Capability[];
  readonly defaults?: Readonly<Record<string, JsonValue>>;
  readonly limits?: {
    readonly counters?: Readonly<Record<string, number>>;
    readonly maxDurationMs?: number;
    readonly maxNodeInvocations?: number;
    readonly maxConcurrentInvocations?: number;
  };
  readonly subworkflows?: Readonly<
    Record<
      string,
      {
        readonly package: string;
        readonly version: string;
      }
    >
  >;
  readonly subagents?: Readonly<Record<string, SubagentAuthoring>>;
}

export interface WorkflowBuilderOptions {
  readonly id: string;
  readonly version: string;
}

export interface RunLimitsAuthoring {
  readonly maxDurationMs?: number;
  readonly maxNodeInvocations?: number;
  readonly maxConcurrentInvocations?: number;
}

export interface SubworkflowAuthoring {
  readonly package: string;
  readonly version: string;
}

export const enum WorkflowAuthoringErrorKind {
  DuplicateNode = 'duplicate_node',
  DuplicateCounter = 'duplicate_counter',
  DuplicateSubagent = 'duplicate_subagent',
  DuplicateSubworkflow = 'duplicate_subworkflow',
  ForeignNodeHandle = 'foreign_node_handle',
  ForeignCounterHandle = 'foreign_counter_handle',
  ForeignSubagentHandle = 'foreign_subagent_handle',
  InvalidContextSource = 'invalid_context_source',
  DuplicateEntry = 'duplicate_entry',
  IncompleteTransition = 'incomplete_transition',
  MissingEntry = 'missing_entry',
}

/** A fail-fast error caused by inconsistent local builder usage. */
export class WorkflowAuthoringError extends Error {
  constructor(
    readonly kind: WorkflowAuthoringErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'WorkflowAuthoringError';
  }
}

export interface NodeHandle {
  readonly id: string;
  readonly kind: 'node';
}

export interface TransitionNodeHandle extends NodeHandle {
  on(outcome: string): TransitionStart;
}

export interface AgentNodeHandle extends TransitionNodeHandle {
  /** Authorizes bounded child roles that this agent may invoke. */
  uses(...subagents: readonly SubagentHandle[]): this;
  /** Declares prior structured agent or subagent outputs to inject into this agent's prompt. */
  withContextFrom(...sources: readonly (AgentNodeHandle | SubagentHandle)[]): this;
}

export interface CompleteNodeHandle extends NodeHandle {}

export interface SubagentHandle {
  readonly id: string;
  readonly kind: 'subagent';
}

export interface CounterHandle {
  readonly name: string;
  readonly limit: number;
  lessThan(value: number): Expression;
  atLeast(value: number): Expression;
  belowLimit(): Expression;
  atLimit(): Expression;
}

export interface TransitionTarget {
  increment(counter: CounterHandle): TransitionTarget;
  to(target: NodeHandle): void;
}

export interface TransitionStart {
  when(condition: Expression): TransitionTarget;
  otherwise(): TransitionTarget;
  increment(counter: CounterHandle): TransitionStart;
  to(target: NodeHandle): void;
}

interface BuilderContext {
  beginTransition(node: NodeHandle, outcome: string): TransitionDraftBuilder;
  addTransition(draft: TransitionDraft, target: NodeHandle): void;
  assertCounterOwnership(counter: CounterHandle): void;
  authorizeSubagents(node: AgentNodeHandle, subagents: readonly SubagentHandle[]): void;
  shareContext(node: AgentNodeHandle, sources: readonly (AgentNodeHandle | SubagentHandle)[]): void;
}

type AgentNodeConfig = AgentNodeAuthoring extends infer Node
  ? Node extends AgentNodeAuthoring
    ? Omit<Node, 'type' | 'allowedSubagents' | 'contextSources'>
    : never
  : never;

interface TransitionDraft {
  readonly from: NodeHandle;
  readonly outcome: string;
  condition?: Expression;
  default?: true;
  increment?: CounterHandle;
}

class AuthoredNodeHandle implements TransitionNodeHandle {
  readonly kind = 'node';

  constructor(
    readonly id: string,
    private readonly context: BuilderContext,
  ) {}

  on(outcome: string): TransitionStart {
    return this.context.beginTransition(this, outcome);
  }
}

class AuthoredAgentNodeHandle implements AgentNodeHandle {
  readonly kind = 'node';

  constructor(
    readonly id: string,
    private readonly context: BuilderContext,
  ) {}

  on(outcome: string): TransitionStart {
    return this.context.beginTransition(this, outcome);
  }

  uses(...subagents: readonly SubagentHandle[]): this {
    this.context.authorizeSubagents(this, subagents);
    return this;
  }

  withContextFrom(...sources: readonly (AgentNodeHandle | SubagentHandle)[]): this {
    this.context.shareContext(this, sources);
    return this;
  }
}

class AuthoredCompleteNodeHandle implements CompleteNodeHandle {
  readonly kind = 'node';

  constructor(readonly id: string) {}
}

class AuthoredSubagentHandle implements SubagentHandle {
  readonly kind = 'subagent';

  constructor(readonly id: string) {}
}

class AuthoredCounterHandle implements CounterHandle {
  constructor(
    readonly name: string,
    readonly limit: number,
  ) {}

  lessThan(value: number): Expression {
    return comparison('lt', this.name, value);
  }

  atLeast(value: number): Expression {
    return comparison('gte', this.name, value);
  }

  belowLimit(): Expression {
    return this.lessThan(this.limit);
  }

  atLimit(): Expression {
    return this.atLeast(this.limit);
  }
}

class TransitionDraftBuilder implements TransitionStart, TransitionTarget {
  constructor(
    private readonly context: BuilderContext,
    private readonly draft: TransitionDraft,
  ) {}

  when(condition: Expression): TransitionTarget {
    this.draft.condition = condition;
    return this;
  }

  otherwise(): TransitionTarget {
    this.draft.default = true;
    return this;
  }

  increment(counter: CounterHandle): this {
    this.context.assertCounterOwnership(counter);
    this.draft.increment = counter;
    return this;
  }

  to(target: NodeHandle): void {
    this.context.addTransition(this.draft, target);
  }
}

/** Owns the mutable state used to author a data-only workflow definition. */
export class WorkflowBuilder implements BuilderContext {
  private readonly nodes = new Map<string, NodeAuthoring>();
  private readonly nodeHandles = new Set<NodeHandle>();
  private readonly counters = new Map<string, number>();
  private readonly counterHandles = new Set<CounterHandle>();
  private readonly transitions: SourceTransition[] = [];
  private readonly pendingTransitions = new Set<TransitionDraft>();
  private readonly subworkflows = new Map<string, SubworkflowAuthoring>();
  private readonly subagents = new Map<string, SubagentAuthoring>();
  private readonly subagentHandles = new Set<SubagentHandle>();
  private entryHandle: NodeHandle | undefined;
  private declaredPermissions: readonly Capability[] | undefined;
  private declaredDefaults: Readonly<Record<string, JsonValue>> | undefined;
  private declaredRunLimits: RunLimitsAuthoring | undefined;

  constructor(private readonly options: WorkflowBuilderOptions) {}

  permissions(...permissions: readonly Capability[]): this {
    this.declaredPermissions = [...permissions];
    return this;
  }

  defaults(defaults: Readonly<Record<string, JsonValue>>): this {
    this.declaredDefaults = { ...defaults };
    return this;
  }

  runLimits(limits: RunLimitsAuthoring): this {
    this.declaredRunLimits = { ...limits };
    return this;
  }

  counter(name: string, limit: number): CounterHandle {
    if (this.counters.has(name)) {
      throw authoringError(
        WorkflowAuthoringErrorKind.DuplicateCounter,
        `Counter "${name}" is already declared`,
      );
    }
    const handle = new AuthoredCounterHandle(name, limit);
    this.counters.set(name, limit);
    this.counterHandles.add(handle);
    return handle;
  }

  subworkflow(name: string, definition: SubworkflowAuthoring): this {
    if (this.subworkflows.has(name)) {
      throw authoringError(
        WorkflowAuthoringErrorKind.DuplicateSubworkflow,
        `Subworkflow "${name}" is already declared`,
      );
    }
    this.subworkflows.set(name, { ...definition });
    return this;
  }

  subagent(name: string, definition: SubagentAuthoring): SubagentHandle {
    if (this.subagents.has(name)) {
      throw authoringError(
        WorkflowAuthoringErrorKind.DuplicateSubagent,
        `Subagent "${name}" is already declared`,
      );
    }
    const handle = new AuthoredSubagentHandle(name);
    this.subagents.set(name, { ...definition });
    this.subagentHandles.add(handle);
    return handle;
  }

  agent(name: string, config: AgentNodeConfig): AgentNodeHandle {
    this.assertUniqueNode(name);
    const handle = new AuthoredAgentNodeHandle(name, this);
    this.nodes.set(name, { type: 'agent', ...config });
    this.nodeHandles.add(handle);
    return handle;
  }

  approval(name: string, config: Omit<ApprovalNodeAuthoring, 'type'>): TransitionNodeHandle {
    return this.addTransitionNode(name, { type: 'approval', ...config });
  }

  /**
   * Adds the human boundary that reviews the exact prepared tree and editable
   * commit/pull-request proposal before local delivery.
   */
  deliveryReview(
    name: string,
    config: Omit<DeliveryReviewNodeAuthoring, 'type'>,
  ): TransitionNodeHandle {
    return this.addTransitionNode(name, { type: 'delivery_review', ...config });
  }

  command(name: string, config: Omit<CommandNodeAuthoring, 'type'>): TransitionNodeHandle {
    return this.addTransitionNode(name, { type: 'command', ...config });
  }

  call(name: string, config: Omit<CallNodeAuthoring, 'type'>): TransitionNodeHandle {
    return this.addTransitionNode(name, { type: 'call', ...config });
  }

  parallel(name: string, config: Omit<ParallelNodeAuthoring, 'type'>): TransitionNodeHandle {
    return this.addTransitionNode(name, { type: 'parallel', ...config });
  }

  forEach(name: string, config: Omit<ForEachNodeAuthoring, 'type'>): TransitionNodeHandle {
    this.assertUniqueNode(name);
    const source =
      typeof config.itemsFrom.node === 'string'
        ? config.itemsFrom.node
        : (this.assertNodeOwnership(config.itemsFrom.node), config.itemsFrom.node.id);
    const handle = new AuthoredNodeHandle(name, this);
    this.nodes.set(name, {
      type: 'for_each',
      ...config,
      itemsFrom: { node: source, path: [...config.itemsFrom.path] },
    });
    this.nodeHandles.add(handle);
    return handle;
  }

  sleep(name: string, config: Omit<SleepNodeAuthoring, 'type'>): TransitionNodeHandle {
    return this.addTransitionNode(name, { type: 'sleep', ...config });
  }

  waitForEvent(
    name: string,
    config: Omit<WaitForEventNodeAuthoring, 'type'>,
  ): TransitionNodeHandle {
    return this.addTransitionNode(name, { type: 'wait_for_event', ...config });
  }

  complete(name: string, config: Omit<CompleteNodeAuthoring, 'type'> = {}): CompleteNodeHandle {
    this.assertUniqueNode(name);
    const handle = new AuthoredCompleteNodeHandle(name);
    this.nodes.set(name, { type: 'complete', ...config });
    this.nodeHandles.add(handle);
    return handle;
  }

  startAt(node: NodeHandle): this {
    this.assertNodeOwnership(node);
    if (this.entryHandle) {
      throw authoringError(
        WorkflowAuthoringErrorKind.DuplicateEntry,
        `Entry node is already assigned to "${this.entryHandle.id}"`,
      );
    }
    this.entryHandle = node;
    return this;
  }

  build(): WorkflowAuthoringDefinition {
    if (!this.entryHandle) {
      throw authoringError(
        WorkflowAuthoringErrorKind.MissingEntry,
        'Workflow entry node has not been assigned',
      );
    }
    const incomplete = this.pendingTransitions.values().next().value;
    if (incomplete) {
      throw authoringError(
        WorkflowAuthoringErrorKind.IncompleteTransition,
        `Transition from "${incomplete.from.id}.${incomplete.outcome}" has no target`,
      );
    }

    const limits = this.buildLimits();
    return {
      id: this.options.id,
      version: this.options.version,
      entry: this.entryHandle.id,
      nodes: Object.fromEntries(this.nodes),
      transitions: this.transitions.map((transition) => ({ ...transition })),
      ...(this.declaredPermissions ? { permissions: [...this.declaredPermissions] } : {}),
      ...(this.declaredDefaults ? { defaults: { ...this.declaredDefaults } } : {}),
      ...(limits ? { limits } : {}),
      ...(this.subworkflows.size > 0
        ? { subworkflows: Object.fromEntries(this.subworkflows) }
        : {}),
      ...(this.subagents.size > 0 ? { subagents: Object.fromEntries(this.subagents) } : {}),
    };
  }

  beginTransition(node: NodeHandle, outcome: string): TransitionDraftBuilder {
    this.assertNodeOwnership(node);
    const draft: TransitionDraft = { from: node, outcome };
    this.pendingTransitions.add(draft);
    return new TransitionDraftBuilder(this, draft);
  }

  addTransition(draft: TransitionDraft, target: NodeHandle): void {
    this.assertNodeOwnership(target);
    if (!this.pendingTransitions.delete(draft)) {
      throw authoringError(
        WorkflowAuthoringErrorKind.IncompleteTransition,
        `Transition from "${draft.from.id}.${draft.outcome}" is already complete`,
      );
    }
    const source = `${draft.from.id}.${draft.outcome}`;
    this.transitions.push({
      id: `${source}.${target.id}`,
      from: { nodeId: draft.from.id, outcome: draft.outcome },
      toNodeId: target.id,
      ...(draft.condition ? { condition: draft.condition } : {}),
      ...(draft.default ? { default: true } : {}),
      ...(draft.increment ? { increment: draft.increment.name } : {}),
    });
  }

  assertCounterOwnership(counter: CounterHandle): void {
    if (!this.counterHandles.has(counter)) {
      throw authoringError(
        WorkflowAuthoringErrorKind.ForeignCounterHandle,
        `Counter "${counter.name}" belongs to another workflow builder`,
      );
    }
  }

  authorizeSubagents(node: AgentNodeHandle, subagents: readonly SubagentHandle[]): void {
    this.assertNodeOwnership(node);
    for (const subagent of subagents) {
      if (!this.subagentHandles.has(subagent)) {
        throw authoringError(
          WorkflowAuthoringErrorKind.ForeignSubagentHandle,
          `Subagent "${subagent.id}" belongs to another workflow builder`,
        );
      }
    }
    const authored = this.nodes.get(node.id);
    if (authored?.type !== 'agent') {
      throw new Error(`Agent handle does not reference an authored agent: ${node.id}`);
    }
    this.nodes.set(node.id, {
      ...authored,
      allowedSubagents: [
        ...new Set([...(authored.allowedSubagents ?? []), ...subagents.map(({ id }) => id)]),
      ],
    });
  }

  shareContext(
    node: AgentNodeHandle,
    sources: readonly (AgentNodeHandle | SubagentHandle)[],
  ): void {
    this.assertNodeOwnership(node);
    if (sources.length === 0) {
      throw authoringError(
        WorkflowAuthoringErrorKind.InvalidContextSource,
        'withContextFrom requires at least one source',
      );
    }
    const references: AgentContextSource[] = [];
    for (const source of sources) {
      if (source.kind === 'subagent') {
        if (!this.subagentHandles.has(source)) {
          throw authoringError(
            WorkflowAuthoringErrorKind.ForeignSubagentHandle,
            `Subagent "${source.id}" belongs to another workflow builder`,
          );
        }
        references.push({ type: 'subagent', id: source.id });
        continue;
      }
      this.assertNodeOwnership(source);
      if (source.id === node.id || this.nodes.get(source.id)?.type !== 'agent') {
        throw authoringError(
          WorkflowAuthoringErrorKind.InvalidContextSource,
          `Context source "${source.id}" must be another agent`,
        );
      }
      references.push({ type: 'agent', id: source.id });
    }
    const authored = this.nodes.get(node.id);
    if (authored?.type !== 'agent') {
      throw new Error(`Agent handle does not reference an authored agent: ${node.id}`);
    }
    const unique = new Map(
      [...(authored.contextSources ?? []), ...references].map((source) => [
        `${source.type}:${source.id}`,
        source,
      ]),
    );
    this.nodes.set(node.id, { ...authored, contextSources: [...unique.values()] });
  }

  private addTransitionNode(name: string, node: NodeAuthoring): TransitionNodeHandle {
    this.assertUniqueNode(name);
    const handle = new AuthoredNodeHandle(name, this);
    this.nodes.set(name, node);
    this.nodeHandles.add(handle);
    return handle;
  }

  private assertUniqueNode(name: string): void {
    if (this.nodes.has(name)) {
      throw authoringError(
        WorkflowAuthoringErrorKind.DuplicateNode,
        `Node "${name}" is already declared`,
      );
    }
  }

  private assertNodeOwnership(node: NodeHandle): void {
    if (!this.nodeHandles.has(node)) {
      throw authoringError(
        WorkflowAuthoringErrorKind.ForeignNodeHandle,
        `Node "${node.id}" belongs to another workflow builder`,
      );
    }
  }

  private buildLimits(): WorkflowAuthoringDefinition['limits'] | undefined {
    const counters = this.counters.size > 0 ? Object.fromEntries(this.counters) : undefined;
    if (!counters && !this.declaredRunLimits) {
      return undefined;
    }
    return {
      ...(counters ? { counters } : {}),
      ...this.declaredRunLimits,
    };
  }
}

interface OutputExpression {
  equals(value: JsonPrimitive): Expression;
}

/** Creates an output reference rooted at the provided non-empty path. */
export function output(...path: readonly string[]): OutputExpression {
  const reference = Object.freeze({ scope: 'output' as const, path: Object.freeze([...path]) });
  return Object.freeze({
    equals(value: JsonPrimitive): Expression {
      return Object.freeze({ op: 'eq', left: reference, right: value });
    },
  });
}

/** Creates an immutable invocation-input reference rooted at a non-empty path. */
export function input(...path: readonly string[]): OutputExpression {
  const reference = Object.freeze({ scope: 'input' as const, path: Object.freeze([...path]) });
  return Object.freeze({
    equals(value: JsonPrimitive): Expression {
      return Object.freeze({ op: 'eq', left: reference, right: value });
    },
  });
}

/** Requires every provided expression to match. */
export function all(...expressions: readonly Expression[]): Expression {
  return Object.freeze({ op: 'and', expressions: Object.freeze([...expressions]) });
}

/** Requires at least one provided expression to match. */
export function any(...expressions: readonly Expression[]): Expression {
  return Object.freeze({ op: 'or', expressions: Object.freeze([...expressions]) });
}

/** Negates an expression. */
export function not(expression: Expression): Expression {
  return Object.freeze({ op: 'not', expression });
}

function comparison(op: 'gte' | 'lt', counter: string, right: number): Expression {
  return Object.freeze({
    op,
    left: Object.freeze({ scope: 'counter' as const, name: counter }),
    right,
  });
}

function authoringError(kind: WorkflowAuthoringErrorKind, message: string): WorkflowAuthoringError {
  return new WorkflowAuthoringError(kind, message);
}
