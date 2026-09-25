import type {
  ArtifactType,
  Binding,
  BindingSource,
  CompleteNode,
  ApprovalNode,
  CounterDefinition,
  CommandNode,
  CommandResult,
  ControlEdge,
  JsonValue,
  Node,
  Port,
  ScriptedAgentProfile,
  WorkflowDefinitionSource,
  AgentNode,
  UnsupportedNode,
  CallNode,
  ForkNode,
  JoinNode,
  LoopNode,
  ForEachNode,
  JoinMode,
  JoinFailure,
  Harness,
  ScoutDefinition,
  ScoutPolicy,
  WorkflowCapability,
} from "./contracts";

export type SchemaInput<T = unknown> = ArtifactType<T> | JsonValue;

export interface InputHandle<T = unknown> {
  readonly kind: "input";
  readonly workflowId: string;
  readonly name: string;
  readonly schema: SchemaInput<T>;
  readonly required: boolean;
  readonly __type?: T;
  readonly ownerToken: symbol;
}

export interface OutputHandle<T = unknown> {
  readonly kind: "output";
  readonly workflowId: string;
  readonly sourceId: string;
  readonly port: string;
  readonly schema: SchemaInput<T>;
  readonly __type?: T;
  readonly ownerToken: symbol;
}

export interface ScoutHandle<T = unknown> {
  readonly kind: "scout";
  readonly workflowId: string;
  readonly id: string;
  readonly definitionId: string;
  readonly schema: SchemaInput<T>;
  readonly ownerToken: symbol;
}

export interface ScoutResultsHandle<T = unknown> {
  readonly kind: "scout-results";
  readonly workflowId: string;
  readonly sourceId: string;
  readonly scoutId: string;
  readonly schema: SchemaInput<T[]>;
  readonly ownerToken: symbol;
}

export type ValueBinding<T = unknown> =
  | InputHandle<T>
  | OutputHandle<T>
  | ScoutResultsHandle<T>
  | JsonValue;

export interface AgentOptions<T = unknown> {
  readonly role?: string;
  readonly prompt: string;
  /** Optional per-agent harness override. Defaults to the run execution profile. */
  readonly harness?: Harness;
  /** Optional provider/model reference for model-backed execution profiles. */
  readonly modelId?: string;
  readonly workspaceAccess?: "read-only" | "workspace-write";
  readonly capabilities?: readonly WorkflowCapability[];
  readonly input?: Readonly<Record<string, ValueBinding>>;
  readonly produces?: ArtifactType<T>;
  /** Maximum attempt duration; omit it to run until completion or cancellation. */
  readonly timeoutMs?: number;
  readonly uses?: readonly ScoutHandle[];
  readonly scoutPolicy?: Partial<ScoutPolicy>;
  readonly scripted?: ScriptedAgentProfile;
  readonly resources?: Readonly<Record<string, number>>;
}

export interface SubagentOptions<T = unknown> {
  readonly role?: string;
  readonly prompt: string;
  /** Optional per-subagent harness override. Defaults to the run execution profile. */
  readonly harness?: Harness;
  /** Optional provider/model reference for model-backed execution profiles. */
  readonly modelId?: string;
  /** Input schemas exposed to the subagent. */
  readonly input?: Readonly<Record<string, SchemaInput>>;
  /** The single typed report returned by the subagent. */
  readonly produces: ArtifactType<T>;
  /** Maximum child attempt duration; omit it to run until completion or cancellation. */
  readonly timeoutMs?: number;
  readonly scripted?: ScriptedAgentProfile;
  readonly resources?: Readonly<Record<string, number>>;
}

export interface SubagentLimits {
  readonly maxInvocations?: number;
  readonly maxConcurrent?: number;
  readonly optional?: boolean;
}

export interface CommandOptions {
  readonly executable: string;
  readonly executionMode?: "enforced" | "trusted-unrestricted";
  readonly capabilities?: readonly WorkflowCapability[];
  readonly args?: readonly string[];
  readonly input?: Readonly<Record<string, ValueBinding>>;
  readonly timeoutMs?: number;
  readonly acceptedExitCodes?: readonly number[];
  readonly resources?: Readonly<Record<string, number>>;
}

export interface CompleteOptions {
  readonly input?: Readonly<Record<string, ValueBinding>>;
  readonly output?: ValueBinding;
  readonly result?: "succeeded" | "failed";
}

export interface EdgeOptions {
  readonly id?: string;
  readonly guard?: JsonValue;
  readonly default?: boolean;
  readonly counterIncrement?: string;
  readonly feedbackBindings?: Readonly<Record<string, ValueBinding>>;
}

export interface CounterHandle {
  readonly kind: "counter";
  readonly workflowId: string;
  readonly id: string;
  readonly max: number;
  belowLimit(): JsonValue;
}

export interface RepairOptions {
  readonly maxRepairs: number;
  readonly feedback?: ValueBinding;
  readonly exhausted: NodeHandle<any, any>;
}
export interface ParallelOptions {
  readonly branches: readonly NodeHandle<any, any>[];
  readonly maxConcurrent?: number;
}
export interface JoinOptions {
  readonly mode?: JoinMode;
  readonly failure?: JoinFailure;
  readonly groupId?: string;
}
export interface LoopOptions {
  readonly body: NodeHandle<any, any>;
  readonly maxIterations: number;
  readonly carry?: Readonly<Record<string, SchemaInput>>;
  readonly initial?: Readonly<Record<string, ValueBinding>>;
}
export interface ForEachOptions {
  readonly template: WorkflowBuilder;
  readonly collection: ValueBinding;
  readonly itemPort?: string;
  readonly maxItems: number;
  readonly maxConcurrent: number;
}

interface InternalPort extends Port {
  readonly schema: JsonValue;
  readonly schemaLabel: string;
}

type InternalNode = (
  | AgentNode
  | CommandNode
  | ApprovalNode
  | CompleteNode
  | CallNode
  | ForkNode
  | JoinNode
  | LoopNode
  | ForEachNode
  | UnsupportedNode
) & {
  readonly inputPorts: readonly InternalPort[];
  readonly outputPorts: readonly InternalPort[];
};

/** A small authoring handle. Handles are owned by one WorkflowBuilder. */
export class NodeHandle<T = unknown, HasOutput extends boolean = true> {
  readonly workflowId: string;
  readonly id: string;
  readonly ownerToken: symbol;
  declare readonly output: HasOutput extends true ? OutputHandle<T> : never;
  readonly __nodeHandle = true as const;
  private readonly owner: WorkflowBuilder;

  constructor(owner: WorkflowBuilder, id: string, output: OutputHandle<T> | undefined) {
    this.owner = owner;
    this.workflowId = owner.id;
    this.id = id;
    this.ownerToken = owner.ownerToken;
    if (output !== undefined)
      Object.defineProperty(this, "output", { value: output, enumerable: true });
  }

  on(outcome: string): EdgeBuilder {
    return new EdgeBuilder(this.owner, this.id, outcome);
  }
}

export class EdgeBuilder {
  constructor(
    private readonly owner: WorkflowBuilder,
    private readonly sourceNodeId: string,
    private readonly outcome: string,
  ) {}

  to(target: NodeHandle<any, any>, options: EdgeOptions = {}): void {
    this.owner.addEdge(this.sourceNodeId, this.outcome, target, options);
  }

  repair(target: NodeHandle<any, any>, options: RepairOptions): void {
    assertHandleOwner(target, this.owner);
    assertHandleOwner(options.exhausted, this.owner);
    if (!Number.isSafeInteger(options.maxRepairs) || options.maxRepairs < 0)
      throw new Error("maxRepairs must be a non-negative safe integer");
    const counterId = `${this.sourceNodeId}:${this.outcome}:repairs`;
    this.owner.counter(counterId, { max: options.maxRepairs });
    this.owner.addEdge(this.sourceNodeId, this.outcome, target, {
      id: `${this.sourceNodeId}:${this.outcome}:repair`,
      guard: { kind: "counter-below-limit", counterId },
      counterIncrement: counterId,
      ...(options.feedback === undefined
        ? {}
        : { feedbackBindings: { feedback: options.feedback } }),
    });
    this.owner.addEdge(this.sourceNodeId, this.outcome, options.exhausted, {
      id: `${this.sourceNodeId}:${this.outcome}:repair-exhausted`,
      default: true,
    });
  }
}

export interface WorkflowBuilderOptions {
  readonly id: string;
  readonly version?: string;
  readonly limits?: WorkflowDefinitionSource["limits"];
}

function schemaValue(input: SchemaInput): JsonValue {
  if (typeof input === "object" && input !== null && "id" in input && "schema" in input) {
    return (input as ArtifactType).schema;
  }
  return input as JsonValue;
}

function schemaLabel(input: SchemaInput, fallback: string): string {
  if (typeof input === "object" && input !== null && "id" in input && "schema" in input) {
    return String((input as ArtifactType).id);
  }
  return fallback;
}

function port(name: string, schema: SchemaInput, required = true): InternalPort {
  return {
    name,
    schemaDigest: schemaLabel(schema, `${name}.schema`),
    schema: schemaValue(schema),
    schemaLabel: schemaLabel(schema, `${name}.schema`),
    required,
  };
}

function defaultOutput<T>(
  nodeId: string,
  produces: ArtifactType<T> | undefined,
  fallbackSchema: JsonValue = {},
) {
  const schema =
    produces ?? ({ id: `${nodeId}.output`, schema: fallbackSchema } as ArtifactType<T>);
  return port("output", schema);
}

function directSubagentSource<T>(
  id: string,
  options: SubagentOptions<T>,
): WorkflowDefinitionSource {
  if (!id) throw new Error("Subagent id must be non-empty");
  const inputPorts = Object.entries(options.input ?? {}).map(([name, schema]) =>
    port(name, schema),
  );
  const output = defaultOutput("subagent", options.produces);
  const agentId = "subagent";
  const completeId = "complete";
  const agent: AgentNode = {
    id: agentId,
    kind: "agent",
    role: options.role ?? id,
    prompt: options.prompt,
    ...(options.harness === undefined ? {} : { harness: options.harness }),
    ...(options.modelId === undefined ? {} : { modelId: options.modelId }),
    inputPorts: inputPorts.map(stripPort),
    outputPorts: [stripPort(output)],
    bindings: inputPorts.map((input) => ({
      targetPort: input.name,
      source: { kind: "input" as const, sourceId: input.name, port: input.name },
      missing: "error" as const,
    })),
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: finitePositive(options.timeoutMs, 5_000) }),
    ...(options.scripted === undefined ? {} : { scripted: options.scripted }),
    ...(options.resources === undefined ? {} : { resources: options.resources }),
  };
  const complete: CompleteNode = {
    id: completeId,
    kind: "complete",
    inputPorts: [stripPort(output)],
    outputPorts: [],
    bindings: [
      {
        targetPort: "output",
        source: { kind: "producer", sourceId: agentId, port: "output" },
        missing: "error",
      },
    ],
    result: "succeeded",
  };
  const schemaCatalog: Record<string, JsonValue> = {};
  for (const input of inputPorts) schemaCatalog[input.schemaLabel] = input.schema;
  schemaCatalog[output.schemaLabel] = output.schema;
  return {
    id,
    version: "1",
    nodes: [agent, complete],
    controlEdges: [
      {
        id: `${agentId}:success:${completeId}:0`,
        sourceNodeId: agentId,
        outcome: "success",
        targetNodeId: completeId,
        kind: "sequential",
      },
    ],
    inputPorts: inputPorts.map(stripPort),
    outputPorts: [stripPort(output)],
    entry: agentId,
    schemaCatalog,
    counters: [],
    definitions: {},
    sourceMap: {
      [agentId]: { sourceId: agentId },
      [completeId]: { sourceId: completeId },
    },
    scouts: [],
  };
}

function bindingSource(value: ValueBinding, owner: WorkflowBuilder): BindingSource {
  if (isInputHandle(value)) {
    assertHandleOwner(value, owner);
    return { kind: "input", sourceId: value.name, port: value.name };
  }
  if (isOutputHandle(value)) {
    assertHandleOwner(value, owner);
    return { kind: "producer", sourceId: value.sourceId, port: value.port };
  }
  if (isScoutResultsHandle(value)) {
    assertHandleOwner(value, owner);
    return { kind: "scout-results", sourceId: value.sourceId, scoutId: value.scoutId };
  }
  return { kind: "literal", value };
}

function bindings(
  values: Readonly<Record<string, ValueBinding>> | undefined,
  owner: WorkflowBuilder,
): Binding[] {
  return Object.entries(values ?? {}).map(([targetPort, value]) => ({
    targetPort,
    source: bindingSource(value, owner),
    missing: isInputHandle(value) && !value.required ? ("omit" as const) : ("error" as const),
  }));
}

function assertWorkflow(actual: string, expected: string): void {
  if (actual !== expected)
    throw new Error(`Handle belongs to workflow ${actual}, expected ${expected}`);
}

function assertHandleOwner(
  handle: { workflowId: string; ownerToken: symbol },
  owner: WorkflowBuilder,
): void {
  assertWorkflow(handle.workflowId, owner.id);
  if (handle.ownerToken !== owner.ownerToken)
    throw new Error(`Handle belongs to another WorkflowBuilder instance`);
}

function isInputHandle(value: unknown): value is InputHandle {
  return (
    typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "input"
  );
}

function isOutputHandle(value: unknown): value is OutputHandle {
  return (
    typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "output"
  );
}

function isScoutResultsHandle(value: unknown): value is ScoutResultsHandle {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "scout-results"
  );
}

export function artifactType<T = unknown>(id: string, schema: JsonValue): ArtifactType<T> {
  if (!id || typeof id !== "string") throw new Error("artifactType id must be a non-empty string");
  return Object.freeze({ id, schema });
}

/** A declarative workflow source. Compilation is separate and asynchronous. */
export class WorkflowBuilder {
  readonly id: string;
  readonly version: string;
  private readonly limits: WorkflowDefinitionSource["limits"];
  private readonly nodeMap = new Map<string, InternalNode>();
  private readonly edgeList: ControlEdge[] = [];
  private readonly inputMap = new Map<string, InputHandle>();
  private readonly counterMap = new Map<string, CounterDefinition>();
  private readonly childDefinitions = new Map<string, WorkflowDefinitionSource>();
  private readonly sourceMap = new Map<string, { sourceId: string }>();
  private readonly outputMap = new Map<string, InternalPort>();
  private readonly scoutList: ScoutDefinition[] = [];
  private entryId: string | undefined;
  readonly ownerToken = Symbol("workflow-owner");

  constructor(options: WorkflowBuilderOptions) {
    if (!options.id) throw new Error("WorkflowBuilder id must be non-empty");
    this.id = options.id;
    this.version = options.version ?? "1";
    this.limits = options.limits;
  }

  input<T = unknown>(
    name: string,
    schema: SchemaInput<T>,
    options: { required?: boolean } = {},
  ): InputHandle<T> {
    if (!name) throw new Error("Workflow input name must be non-empty");
    if (this.inputMap.has(name)) throw new Error(`Duplicate workflow input ${name}`);
    const handle = Object.freeze({
      kind: "input" as const,
      workflowId: this.id,
      name,
      schema,
      required: options.required ?? true,
      __type: undefined as T | undefined,
      ownerToken: this.ownerToken,
    });
    this.inputMap.set(name, handle);
    return handle;
  }

  agent<T = unknown>(
    id: string,
    options: AgentOptions<T> & { readonly produces: ArtifactType<T> },
  ): NodeHandle<T, true>;
  agent(
    id: string,
    options: AgentOptions<never> & { readonly produces?: undefined },
  ): NodeHandle<never, false>;
  agent<T = unknown>(id: string, options: AgentOptions<T>): NodeHandle<T, boolean> {
    const output = options.produces === undefined ? undefined : defaultOutput(id, options.produces);
    const node: InternalNode = {
      id,
      kind: "agent",
      role: options.role ?? id,
      prompt: options.prompt,
      ...(options.harness === undefined ? {} : { harness: options.harness }),
      ...(options.modelId === undefined ? {} : { modelId: options.modelId }),
      ...(options.workspaceAccess === undefined
        ? {}
        : { workspaceAccess: options.workspaceAccess }),
      ...(options.capabilities === undefined
        ? {}
        : { capabilities: [...new Set(options.capabilities)].sort() }),
      inputPorts: Object.entries(options.input ?? {}).map(([name, value]) =>
        port(name, this.schemaOf(value), isInputHandle(value) ? value.required : true),
      ),
      outputPorts: output === undefined ? [] : [output],
      bindings: bindings(options.input, this),
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: finitePositive(options.timeoutMs, 5_000) }),
      ...(options.uses === undefined
        ? {}
        : {
            uses: options.uses.map((scout) => {
              assertScoutOwner(scout, this);
              if (!this.scoutList.some((declared) => declared.id === scout.id))
                throw new Error(`Scout ${scout.id} has not been declared on this workflow`);
              return scout.id;
            }),
          }),
      ...(options.uses === undefined || options.uses.length === 0
        ? {}
        : { scoutPolicy: normalizeScoutPolicy(options.scoutPolicy ?? {}) }),
      scripted: options.scripted,
      ...(options.resources ? { resources: options.resources } : {}),
    } as InternalNode;
    this.addNode(node);
    return this.handle(id, output);
  }

  command(id: string, options: CommandOptions): NodeHandle<CommandResult, true> {
    if (!options.executable) throw new Error(`Command ${id} executable must be non-empty`);
    const output = defaultOutput<CommandResult>(id, undefined, commandResultSchema);
    const node: InternalNode = {
      id,
      kind: "command",
      executable: options.executable,
      ...(options.executionMode ? { executionMode: options.executionMode } : {}),
      ...(options.capabilities === undefined
        ? {}
        : { capabilities: [...new Set(options.capabilities)].sort() }),
      args: [...(options.args ?? [])],
      inputPorts: Object.entries(options.input ?? {}).map(([name, value]) =>
        port(name, this.schemaOf(value), true),
      ),
      outputPorts: [output],
      bindings: bindings(options.input, this),
      timeoutMs: finitePositive(options.timeoutMs, 30_000),
      acceptedExitCodes: [...(options.acceptedExitCodes ?? [0])],
      ...(options.resources ? { resources: options.resources } : {}),
    } as InternalNode;
    this.addNode(node);
    return this.handle(id, output);
  }

  complete(id: string, options: CompleteOptions = {}): NodeHandle<never, false> {
    const inputValues = options.input
      ? { ...options.input }
      : options.output === undefined
        ? {}
        : { output: options.output };
    const node: InternalNode = {
      id,
      kind: "complete",
      inputPorts: Object.entries(inputValues).map(([name, value]) =>
        port(name, this.schemaOf(value), false),
      ),
      outputPorts: [],
      bindings: bindings(inputValues, this),
      result: options.result ?? "succeeded",
    } as InternalNode;
    this.addNode(node);
    return this.handle<never, false>(id, undefined);
  }

  /**
   * Future node kinds are represented explicitly so M1 can fail with a useful
   * compiler diagnostic instead of silently treating them as executable.
   */
  unsupported(
    id: string,
    kind: Exclude<import("./contracts").NodeKind, import("./contracts").SupportedNodeKind>,
  ): NodeHandle<never, false> {
    const node: InternalNode = {
      id,
      kind,
      inputPorts: [],
      outputPorts: [],
      bindings: [],
    } as InternalNode;
    this.addNode(node);
    return this.handle<never, false>(id, undefined);
  }

  approval(
    id: string,
    options: { input?: Readonly<Record<string, ValueBinding>>; action?: string } = {},
  ): NodeHandle<never, false> {
    const node: InternalNode = {
      id,
      kind: "approval",
      action: options.action ?? id,
      inputPorts: Object.entries(options.input ?? {}).map(([name, value]) =>
        port(name, this.schemaOf(value), false),
      ),
      outputPorts: [],
      bindings: bindings(options.input, this),
    } as InternalNode;
    this.addNode(node);
    return this.handle<never, false>(id, undefined);
  }
  call<T = unknown>(
    id: string,
    child: WorkflowBuilder,
    options: { input?: Readonly<Record<string, ValueBinding>> } = {},
  ): NodeHandle<T, true> {
    const childSource = child.build();
    this.childDefinitions.set(child.id, childSource);
    const childInputs = new Map((childSource.inputPorts ?? []).map((value) => [value.name, value]));
    const inputs = options.input ?? {};
    for (const name of Object.keys(inputs)) {
      if (!childInputs.has(name)) throw new Error(`Call ${id} binds unknown child input ${name}`);
    }
    // A call exposes the child's declared ports.  The conventional `output`
    // handle points at the first declared output for the concise case; callers
    // needing multiple outputs can use named output declarations in the child.
    const childSchema = (childPort: Port): SchemaInput => ({
      id: childPort.schemaDigest,
      schema: childSource.schemaCatalog?.[childPort.schemaDigest] ?? {},
    });
    const inputPorts = [...childInputs.values()].map((childPort) => {
      const value = inputs[childPort.name];
      return value === undefined
        ? { ...port(childPort.name, childSchema(childPort)), required: childPort.required }
        : port(childPort.name, this.schemaOf(value), childPort.required);
    });
    const outputPorts = (childSource.outputPorts ?? []).map((childPort) =>
      port(childPort.name, childSchema(childPort), childPort.required),
    );
    const output = outputPorts[0];
    const node: CallNode = {
      id,
      kind: "call",
      definitionId: child.id,
      inputPorts,
      outputPorts,
      bindings: bindings(inputs, this),
    };
    this.addNode(node as InternalNode);
    this.sourceMap.set(id, { sourceId: id });
    return this.handle<T>(id, output);
  }

  /** Declare a child definition that agents may invoke through the subagent tool. */
  scout<T = unknown>(
    id: string,
    child: WorkflowBuilder,
    options: {
      input?: Readonly<Record<string, ValueBinding>>;
      maxInvocations?: number;
      maxConcurrent?: number;
      optional?: boolean;
    } = {},
  ): NodeHandle<T, true> {
    const handle = this.call<T>(id, child, options);
    const maxInvocations = options.maxInvocations ?? 2;
    const maxConcurrent = options.maxConcurrent ?? 2;
    if (!Number.isSafeInteger(maxInvocations) || maxInvocations <= 0)
      throw new Error("scout maxInvocations must be a positive safe integer");
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent <= 0)
      throw new Error("scout maxConcurrent must be a positive safe integer");
    this.scoutList.push({
      id,
      definitionId: child.id,
      maxInvocations,
      maxConcurrent,
      ...(options.optional ? { optional: true } : {}),
    });
    return handle;
  }

  /** Register a child that agents may invoke without adding a static graph activation. */
  declareScout<T = unknown>(
    id: string,
    child: WorkflowBuilder,
    options: { maxInvocations?: number; maxConcurrent?: number; optional?: boolean } = {},
  ): ScoutHandle<T> {
    if (this.scoutList.some((scout) => scout.id === id)) throw new Error(`Duplicate scout ${id}`);
    this.childDefinitions.set(child.id, child.build());
    const maxInvocations = options.maxInvocations ?? 2;
    const maxConcurrent = options.maxConcurrent ?? 2;
    if (!Number.isSafeInteger(maxInvocations) || maxInvocations <= 0)
      throw new Error("scout maxInvocations must be a positive safe integer");
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent <= 0)
      throw new Error("scout maxConcurrent must be a positive safe integer");
    this.scoutList.push({
      id,
      definitionId: child.id,
      maxInvocations,
      maxConcurrent,
      ...(options.optional ? { optional: true } : {}),
    });
    const childOutput = child.build().outputPorts?.[0];
    const schema = childOutput
      ? {
          id: childOutput.schemaDigest,
          schema: child.build().schemaCatalog?.[childOutput.schemaDigest] ?? {},
        }
      : ({ id: `${id}.output`, schema: {} } as ArtifactType);
    return Object.freeze({
      kind: "scout" as const,
      workflowId: this.id,
      id,
      definitionId: child.id,
      schema: schema as SchemaInput<T>,
      ownerToken: this.ownerToken,
    });
  }

  subagent<T = unknown>(
    id: string,
    options: SubagentOptions<T>,
    limits: SubagentLimits = {},
  ): ScoutHandle<T> {
    if (this.scoutList.some((scout) => scout.id === id)) throw new Error(`Duplicate scout ${id}`);
    const child = directSubagentSource(id, options);
    this.childDefinitions.set(id, child);
    const maxInvocations = limits.maxInvocations ?? 2;
    const maxConcurrent = limits.maxConcurrent ?? 2;
    if (!Number.isSafeInteger(maxInvocations) || maxInvocations <= 0)
      throw new Error("scout maxInvocations must be a positive safe integer");
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent <= 0)
      throw new Error("scout maxConcurrent must be a positive safe integer");
    this.scoutList.push({
      id,
      definitionId: id,
      maxInvocations,
      maxConcurrent,
      ...(limits.optional ? { optional: true } : {}),
    });
    return Object.freeze({
      kind: "scout" as const,
      workflowId: this.id,
      id,
      definitionId: id,
      schema: options.produces,
      ownerToken: this.ownerToken,
    });
  }

  /** @deprecated Use subagent(id, options, limits). */
  declareSubagent<T = unknown>(
    id: string,
    options: SubagentOptions<T>,
    limits: SubagentLimits = {},
  ): ScoutHandle<T> {
    return this.subagent(id, options, limits);
  }

  scoutResults<T = unknown>(
    plan: NodeHandle<any, true>,
    scout: ScoutHandle<T>,
  ): ScoutResultsHandle<T> {
    assertHandleOwner(plan, this);
    assertScoutOwner(scout, this);
    const parent = this.nodeMap.get(plan.id);
    if (parent?.kind !== "agent") throw new Error("scoutResults requires an agent");
    if (parent.uses !== undefined && !parent.uses.includes(scout.id))
      throw new Error(`Subagent ${scout.id} is not authorized on agent ${plan.id}`);
    return Object.freeze({
      kind: "scout-results" as const,
      workflowId: this.id,
      sourceId: plan.id,
      scoutId: scout.id,
      schema: {
        id: `${plan.id}.${scout.id}.results`,
        schema: { type: "array", items: schemaValue(scout.schema) },
      },
      ownerToken: this.ownerToken,
    });
  }

  subagentResults<T = unknown>(
    agent: NodeHandle<any, true>,
    subagent: ScoutHandle<T>,
  ): ScoutResultsHandle<T> {
    return this.scoutResults(agent, subagent);
  }
  parallel(id: string, options: ParallelOptions): NodeHandle<never, false> {
    if (!options.branches.length) throw new Error("parallel requires at least one branch");
    options.branches.forEach((branch) => assertHandleOwner(branch, this));
    if (
      options.maxConcurrent !== undefined &&
      (!Number.isSafeInteger(options.maxConcurrent) || options.maxConcurrent <= 0)
    )
      throw new Error("parallel maxConcurrent must be a positive safe integer");
    const node: ForkNode = {
      id,
      kind: "fork",
      groupId: id,
      branchIds: options.branches.map((branch) => branch.id),
      ...(options.maxConcurrent === undefined ? {} : { maxConcurrent: options.maxConcurrent }),
      inputPorts: [],
      outputPorts: [],
      bindings: [],
    };
    this.addNode(node as InternalNode);
    this.sourceMap.set(id, { sourceId: id });
    return this.handle<never, false>(id, undefined);
  }
  fork(id: string, options?: ParallelOptions): NodeHandle<never, false> {
    return options ? this.parallel(id, options) : this.unsupported(id, "fork");
  }
  join(id: string, options: JoinOptions = {}): NodeHandle<never, false> {
    const node: JoinNode = {
      id,
      kind: "join",
      groupId: options.groupId ?? id,
      mode: options.mode ?? "all",
      failure: options.failure ?? "cancel-remaining",
      inputPorts: [],
      outputPorts: [],
      bindings: [],
    };
    this.addNode(node as InternalNode);
    this.sourceMap.set(id, { sourceId: id });
    return this.handle<never, false>(id, undefined);
  }
  loop(id: string, options: LoopOptions): NodeHandle<never, false> {
    if (!Number.isSafeInteger(options.maxIterations) || options.maxIterations <= 0)
      throw new Error("loop maxIterations must be a positive safe integer");
    assertHandleOwner(options.body, this);
    const carry = Object.entries(options.carry ?? {}).map(([name, schema]) => port(name, schema));
    const node: LoopNode = {
      id,
      kind: "loop",
      bodyNodeId: options.body.id,
      maxIterations: options.maxIterations,
      carry,
      inputPorts: Object.entries(options.initial ?? {}).map(([name, value]) =>
        port(name, this.schemaOf(value)),
      ),
      outputPorts: carry,
      bindings: bindings(options.initial, this),
    };
    this.addNode(node as InternalNode);
    this.sourceMap.set(id, { sourceId: id });
    return this.handle<never, false>(id, undefined);
  }
  forEach(id: string, options: ForEachOptions): NodeHandle<unknown[], true> {
    if (!Number.isSafeInteger(options.maxItems) || options.maxItems <= 0)
      throw new Error("forEach maxItems must be a positive safe integer");
    if (!Number.isSafeInteger(options.maxConcurrent) || options.maxConcurrent <= 0)
      throw new Error("forEach maxConcurrent must be a positive safe integer");
    this.childDefinitions.set(options.template.id, options.template.build());
    const collection: Binding = {
      targetPort: "collection",
      source: bindingSource(options.collection, this),
      missing: "error",
    };
    const output = port("output", { id: `${id}.output`, schema: { type: "array" } });
    const node: ForEachNode = {
      id,
      kind: "forEach",
      templateDefinitionId: options.template.id,
      collection,
      itemPort: port(options.itemPort ?? "item", {}),
      maxItems: options.maxItems,
      maxConcurrent: options.maxConcurrent,
      inputPorts: [port("collection", this.schemaOf(options.collection))],
      outputPorts: [output],
      bindings: [collection],
    };
    this.addNode(node as InternalNode);
    this.sourceMap.set(id, { sourceId: id });
    return this.handle<unknown[], true>(id, output);
  }

  sequence(...nodes: readonly NodeHandle<any, any>[]): void {
    for (let index = 0; index < nodes.length - 1; index += 1) {
      assertHandleOwner(nodes[index], this);
      assertHandleOwner(nodes[index + 1], this);
      nodes[index].on("success").to(nodes[index + 1]);
    }
  }

  startAt(node: NodeHandle<any, any>): void {
    assertHandleOwner(node, this);
    this.entryId = node.id;
  }

  output(value: ValueBinding): void;
  output(name: string, value: ValueBinding): void;
  output(nameOrValue: string | ValueBinding, maybeValue?: ValueBinding): void {
    const name = typeof nameOrValue === "string" ? nameOrValue : "output";
    const value = typeof nameOrValue === "string" ? maybeValue : nameOrValue;
    if (value === undefined) throw new Error(`Workflow output ${name} requires a value`);
    if (this.outputMap.has(name)) throw new Error(`Duplicate workflow output ${name}`);
    this.outputMap.set(name, port(name, this.schemaOf(value)));
  }

  build(): WorkflowDefinitionSource {
    return {
      id: this.id,
      version: this.version,
      limits: this.limits,
      nodes: [...this.nodeMap.values()].map((node) => stripInternal(node)),
      controlEdges: this.edgeList.map((edge) => ({ ...edge })),
      inputPorts: [...this.inputMap.values()].map((input) => ({
        name: input.name,
        schemaDigest: schemaLabel(input.schema, `${input.name}.schema`),
        required: input.required,
      })),
      outputPorts: [...this.outputMap.values()].map(stripPort),
      entry: this.entryId,
      schemaCatalog: this.collectSchemas(),
      counters: [...this.counterMap.values()],
      definitions: Object.fromEntries(this.childDefinitions.entries()),
      sourceMap: Object.fromEntries(this.sourceMap.entries()),
      scouts: [...this.scoutList],
    } as WorkflowDefinitionSource;
  }

  /** @internal Used by the compiler to retain schema source values. */
  _nodes(): readonly InternalNode[] {
    return [...this.nodeMap.values()];
  }

  /** @internal */
  addEdge(
    sourceNodeId: string,
    outcome: string,
    target: NodeHandle<any, any>,
    options: EdgeOptions,
  ): void {
    assertHandleOwner(target, this);
    if (!this.nodeMap.has(sourceNodeId)) throw new Error(`Unknown source node ${sourceNodeId}`);
    if (!this.nodeMap.has(target.id)) throw new Error(`Unknown target node ${target.id}`);
    const edge: ControlEdge = {
      id: options.id ?? `${sourceNodeId}:${outcome}:${target.id}:${this.edgeList.length}`,
      sourceNodeId,
      outcome,
      targetNodeId: target.id,
      kind: "sequential",
      ...(options.guard === undefined ? {} : { guard: options.guard }),
      ...(options.default === undefined ? {} : { default: options.default }),
      ...(options.counterIncrement === undefined
        ? {}
        : { counterIncrement: options.counterIncrement }),
      ...(options.feedbackBindings
        ? { feedbackBindings: bindings(options.feedbackBindings, this) }
        : {}),
    };
    if (this.edgeList.some((existing) => existing.id === edge.id))
      throw new Error(`Duplicate control edge ${edge.id}`);
    this.edgeList.push(edge);
  }

  counter(id: string, options: { max: number }): CounterHandle {
    if (!id) throw new Error("Counter id must be non-empty");
    if (!Number.isSafeInteger(options.max) || options.max < 0)
      throw new Error("Counter max must be a non-negative safe integer");
    const previous = this.counterMap.get(id);
    if (previous && previous.max !== options.max)
      throw new Error(`Counter ${id} already exists with max ${previous.max}`);
    this.counterMap.set(id, { id, max: options.max });
    return {
      kind: "counter",
      workflowId: this.id,
      id,
      max: options.max,
      belowLimit: () => ({ kind: "counter-below-limit", counterId: id }),
    };
  }

  private addNode(node: InternalNode): void {
    if (!node.id) throw new Error("Node id must be non-empty");
    if (this.nodeMap.has(node.id)) throw new Error(`Duplicate node ${node.id}`);
    this.nodeMap.set(node.id, node);
  }

  private handle<T, O extends boolean = true>(
    id: string,
    output: InternalPort | undefined,
  ): NodeHandle<T, O> {
    if (output === undefined) return new NodeHandle(this, id, undefined) as NodeHandle<T, O>;
    const descriptor: OutputHandle<T> = Object.freeze({
      kind: "output",
      workflowId: this.id,
      sourceId: id,
      port: output.name,
      schema: { id: output.schemaLabel, schema: output.schema },
      __type: undefined,
      ownerToken: this.ownerToken,
    });
    return new NodeHandle(this, id, descriptor) as NodeHandle<T, O>;
  }

  private schemaOf(value: ValueBinding): SchemaInput {
    if (isInputHandle(value) || isOutputHandle(value) || isScoutResultsHandle(value))
      return value.schema;
    return {};
  }

  private collectSchemas(): Readonly<Record<string, JsonValue>> {
    const result: Record<string, JsonValue> = {};
    for (const input of this.inputMap.values())
      result[schemaLabel(input.schema, `${input.name}.schema`)] = schemaValue(input.schema);
    for (const output of this.outputMap.values()) result[output.schemaLabel] = output.schema;
    for (const node of this.nodeMap.values()) {
      for (const p of node.inputPorts) result[p.schemaLabel] = p.schema;
      for (const p of node.outputPorts) result[p.schemaLabel] = p.schema;
    }
    return result;
  }
}

function assertScoutOwner(handle: ScoutHandle, owner: WorkflowBuilder): void {
  assertWorkflow(handle.workflowId, owner.id);
  if (handle.ownerToken !== owner.ownerToken)
    throw new Error("Scout handle belongs to another WorkflowBuilder instance");
}

function normalizeScoutPolicy(policy: Partial<ScoutPolicy>): ScoutPolicy {
  const maxRequests = policy.maxRequests ?? 4;
  const maxConcurrent = policy.maxConcurrent ?? 2;
  if (!Number.isSafeInteger(maxRequests) || maxRequests <= 0)
    throw new Error("scoutPolicy.maxRequests must be a positive safe integer");
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent <= 0)
    throw new Error("scoutPolicy.maxConcurrent must be a positive safe integer");
  return { maxRequests, maxConcurrent };
}

function stripInternal(node: InternalNode): Node {
  const base = {
    id: node.id,
    kind: node.kind,
    inputPorts: node.inputPorts.map(stripPort),
    outputPorts: node.outputPorts.map(stripPort),
    bindings: node.bindings,
  };
  if (
    node.kind === "call" ||
    node.kind === "fork" ||
    node.kind === "join" ||
    node.kind === "loop" ||
    node.kind === "forEach"
  )
    return { ...base, ...node } as Node;
  if (node.kind === "agent") {
    return {
      ...base,
      role: node.role,
      prompt: node.prompt,
      ...(node.harness === undefined ? {} : { harness: node.harness }),
      ...(node.modelId === undefined ? {} : { modelId: node.modelId }),
      ...(node.workspaceAccess === undefined ? {} : { workspaceAccess: node.workspaceAccess }),
      ...(node.capabilities === undefined ? {} : { capabilities: node.capabilities }),
      ...(node.timeoutMs === undefined ? {} : { timeoutMs: node.timeoutMs }),
      ...(node.uses === undefined ? {} : { uses: node.uses }),
      ...(node.scoutPolicy === undefined ? {} : { scoutPolicy: node.scoutPolicy }),
      ...(node.scripted === undefined ? {} : { scripted: node.scripted }),
    } as AgentNode;
  }
  if (node.kind === "command") {
    return {
      ...base,
      executable: node.executable,
      ...(node.executionMode === undefined ? {} : { executionMode: node.executionMode }),
      ...(node.capabilities === undefined ? {} : { capabilities: node.capabilities }),
      args: node.args,
      timeoutMs: node.timeoutMs,
      acceptedExitCodes: node.acceptedExitCodes,
    } as CommandNode;
  }
  if (node.kind === "complete") return { ...base, result: node.result } as CompleteNode;
  if (node.kind === "approval") return { ...base, action: node.action } as ApprovalNode;
  return base as UnsupportedNode;
}

function stripPort(value: InternalPort): Port {
  return {
    name: value.name,
    schemaDigest: value.schemaDigest,
    required: value.required,
    ...(value.defaultValue === undefined ? {} : { defaultValue: value.defaultValue }),
    ...(value.outcomes === undefined ? {} : { outcomes: value.outcomes }),
  };
}

function finitePositive(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0)
    throw new Error("Timeout must be a finite positive number");
  return Math.floor(value);
}

export const commandEvidenceSchema: JsonValue = {
  type: "object",
  properties: {
    kind: { const: "command.evidence" },
    executable: { type: "string" },
    args: { type: "array", items: { type: "string" } },
    exitCode: { type: ["integer", "null"] },
    executionMode: { enum: ["enforced", "trusted-unrestricted"] },
    signal: { type: ["string", "null"] },
    timeout: { type: ["boolean", "null"] },
    spawnError: { type: ["string", "null"] },
  },
  required: ["kind", "executable", "args", "exitCode", "signal", "timeout", "spawnError"],
  additionalProperties: false,
};

export const commandResultSchema: JsonValue = {
  type: "object",
  properties: {
    exitCode: { type: ["integer", "null"] },
    executionMode: { enum: ["enforced", "trusted-unrestricted"] },
    signal: { type: ["string", "null"] },
    timeout: { type: ["boolean", "null"] },
    spawnError: { type: ["string", "null"] },
    startedAt: { type: ["string", "null"] },
    finishedAt: { type: ["string", "null"] },
    durationMs: { type: ["number", "null"] },
  },
  required: [
    "exitCode",
    "signal",
    "timeout",
    "spawnError",
    "startedAt",
    "finishedAt",
    "durationMs",
  ],
  additionalProperties: false,
};
