import {
  BUNDLE_FORMAT_VERSION,
  CompileError,
  DEFAULT_LIMITS,
  type Binding,
  type Bundle,
  type BoundSummary,
  type ControlEdge,
  type Definition,
  type Diagnostic,
  type ExecutionLimits,
  type JsonValue,
  type Node,
  type Port,
  type WorkflowDefinitionSource,
} from "./contracts";
import { canonicalize, sha256Hex } from "./canonical";

const COMPILER_VERSION = "1.0";
const EXPRESSION_VERSION = "1.0";
const SCHEMA_VERSION = "2020-12";
const SATURATION = Number.MAX_SAFE_INTEGER;

export interface CompilationResult {
  readonly bundle?: Bundle;
  readonly diagnostics: readonly Diagnostic[];
}

/** Compile a trusted plain authoring source into an immutable content-addressed bundle. */
export async function compileWorkflow(source: WorkflowDefinitionSource): Promise<Bundle> {
  const result = await compileWorkflowDetailed(source);
  if (!result.bundle) throw new CompileError(result.diagnostics);
  return result.bundle;
}

export async function compileWorkflowDetailed(
  source: WorkflowDefinitionSource,
): Promise<CompilationResult> {
  const diagnostics: Diagnostic[] = [];
  const childBundles: Bundle[] = [];
  if (!source || typeof source !== "object") {
    return {
      diagnostics: [
        { code: "INVALID_SOURCE", message: "Workflow source must be an object", severity: "error" },
      ],
    };
  }
  if (!source.id)
    diagnostics.push(error("INVALID_WORKFLOW_ID", "Workflow id must be non-empty", source.id));
  const limits = normalizeLimits(source.limits, diagnostics);
  const schemaInput = source.schemaCatalog ?? {};
  const schemaDigests: Record<string, string> = {};
  const schemas: Record<string, JsonValue> = {};
  for (const label of Object.keys(schemaInput).sort()) {
    try {
      const canonical = canonicalize(schemaInput[label]);
      const digest = `sha256:${await sha256Hex(canonical)}`;
      schemaDigests[label] = digest;
      schemas[digest] = schemaInput[label];
    } catch (cause) {
      diagnostics.push(
        error("INVALID_SCHEMA", cause instanceof Error ? cause.message : String(cause), label),
      );
    }
  }

  const nodes = Array.isArray(source.nodes) ? source.nodes : [];
  const counters = Array.isArray(source.counters) ? source.counters : [];
  const counterIds = new Set<string>();
  for (const counter of counters) {
    if (counterIds.has(counter.id))
      diagnostics.push(error("DUPLICATE_COUNTER", `Duplicate counter ${counter.id}`, counter.id));
    counterIds.add(counter.id);
    if (!counter.id || !Number.isSafeInteger(counter.max) || counter.max < 0)
      diagnostics.push(
        error(
          "INVALID_COUNTER",
          `Counter ${counter.id} must have a non-negative safe max`,
          counter.id,
        ),
      );
  }
  const nodeIds = new Set<string>();
  const nodeMap = new Map<string, Node>();
  for (const node of nodes) {
    if (!node || typeof node !== "object") {
      diagnostics.push(error("INVALID_NODE", "Node must be an object"));
      continue;
    }
    if (nodeIds.has(node.id))
      diagnostics.push(error("DUPLICATE_NODE", `Duplicate node ${node.id}`, node.id));
    nodeIds.add(node.id);
    nodeMap.set(node.id, node);
    if (
      ![
        "agent",
        "command",
        "approval",
        "complete",
        "call",
        "fork",
        "join",
        "loop",
        "forEach",
      ].includes(node.kind)
    ) {
      diagnostics.push(
        error(
          "UNSUPPORTED_NODE_KIND",
          `Node kind ${node.kind} is unsupported by this compiler`,
          node.id,
        ),
      );
    }
    validatePorts(node.inputPorts, schemaDigests, diagnostics, node.id);
    validatePorts(node.outputPorts, schemaDigests, diagnostics, node.id);
    if (node.kind === "call" && !source.definitions?.[node.definitionId])
      diagnostics.push(
        error(
          "MISSING_CHILD_DEFINITION",
          `Call references missing child definition ${node.definitionId}`,
          node.id,
        ),
      );
    if (node.kind === "join" && !["all", "all-settled", "fail-fast"].includes(node.mode))
      diagnostics.push(error("INVALID_JOIN_MODE", `Unsupported join mode ${node.mode}`, node.id));
    if (
      node.kind === "loop" &&
      (!Number.isSafeInteger(node.maxIterations) || node.maxIterations <= 0)
    )
      diagnostics.push(
        error("UNBOUNDED_LOOP", "Loop maxIterations must be a positive safe integer", node.id),
      );
    if (
      node.kind === "forEach" &&
      (!Number.isSafeInteger(node.maxItems) ||
        node.maxItems <= 0 ||
        !Number.isSafeInteger(node.maxConcurrent) ||
        node.maxConcurrent <= 0)
    )
      diagnostics.push(
        error(
          "INVALID_MAP_BOUND",
          "forEach maxItems and maxConcurrent must be positive safe integers",
          node.id,
        ),
      );
  }
  for (const node of nodes) {
    validateBindings(
      node.bindings,
      node.inputPorts,
      nodeMap,
      source.inputPorts ?? [],
      diagnostics,
      node.id,
    );
    validateBindingSchemas(node, nodeMap, source.inputPorts ?? [], diagnostics);
    if (node.kind === "call") {
      const child = source.definitions?.[node.definitionId];
      if (child) validateCallInterface(node, child, diagnostics);
    }
  }

  const entry = source.entry;
  if (!entry) diagnostics.push(error("MISSING_ENTRY", "Workflow must declare an entry node"));
  else if (!nodeIds.has(entry))
    diagnostics.push(error("UNKNOWN_ENTRY", `Entry node ${entry} does not exist`, entry));

  const edges = Array.isArray(source.controlEdges) ? source.controlEdges : [];
  validateStructuralTopology(nodes, edges, nodeMap, diagnostics);
  const edgeIds = new Set<string>();
  const edgeSignatures = new Set<string>();
  for (const edge of edges) {
    if (edgeIds.has(edge.id))
      diagnostics.push(error("DUPLICATE_EDGE_ID", `Duplicate control edge ${edge.id}`, edge.id));
    edgeIds.add(edge.id);
    if (!nodeIds.has(edge.sourceNodeId))
      diagnostics.push(
        error("UNKNOWN_EDGE_SOURCE", `Unknown edge source ${edge.sourceNodeId}`, edge.id),
      );
    if (!nodeIds.has(edge.targetNodeId))
      diagnostics.push(
        error("UNKNOWN_EDGE_TARGET", `Unknown edge target ${edge.targetNodeId}`, edge.id),
      );
    const signature = canonicalize({
      sourceNodeId: edge.sourceNodeId,
      outcome: edge.outcome,
      targetNodeId: edge.targetNodeId,
      ...(edge.guard === undefined ? {} : { guard: edge.guard }),
      ...(edge.default === undefined ? {} : { default: edge.default }),
      ...(edge.counterIncrement === undefined ? {} : { counterIncrement: edge.counterIncrement }),
      ...(edge.feedbackBindings === undefined ? {} : { feedbackBindings: edge.feedbackBindings }),
    });
    if (edgeSignatures.has(signature))
      diagnostics.push(
        error("DUPLICATE_EDGE", "Exact duplicate control edges are not allowed", edge.id),
      );
    edgeSignatures.add(signature);
    const sourceNode = nodeMap.get(edge.sourceNodeId);
    if (sourceNode?.kind === "complete")
      diagnostics.push(
        error("EDGE_FROM_COMPLETE", "Complete nodes cannot have outgoing edges", edge.id),
      );
    if (edge.counterIncrement !== undefined && !counterIds.has(edge.counterIncrement))
      diagnostics.push(
        error("UNKNOWN_COUNTER", `Unknown counter ${edge.counterIncrement}`, edge.id),
      );
    if (edge.guard !== undefined && !isSupportedGuard(edge.guard, counterIds)) {
      diagnostics.push(
        error("INVALID_GUARD", "Guard is not a supported deterministic expression", edge.id),
      );
      diagnostics.push(
        error(
          "UNSUPPORTED_EDGE_FEATURE",
          "This guard is not supported by the current compiler",
          edge.id,
        ),
      );
    }
    const allowedOutcomes =
      sourceNode?.kind === "approval" ? ["approved", "rejected"] : ["success", "failure"];
    if (sourceNode?.kind && !allowedOutcomes.includes(edge.outcome)) {
      diagnostics.push(
        error("UNSUPPORTED_OUTCOME", `Outcome ${edge.outcome} is not supported in M1`, edge.id),
      );
    }
  }
  for (const node of nodes) {
    const successOutcome = node.kind === "approval" ? "approved" : "success";
    if (
      node.kind !== "complete" &&
      !edges.some((edge) => edge.sourceNodeId === node.id && edge.outcome === successOutcome)
    ) {
      diagnostics.push(
        error("MISSING_SUCCESS_ROUTE", `Node ${node.id} has no success route`, node.id),
      );
    }
    for (const outcome of ["success", "failure"]) {
      const routes = edges.filter(
        (edge) => edge.sourceNodeId === node.id && edge.outcome === outcome,
      );
      const meaningfulRoutes = routes.filter((edge) => !edge.default);
      if (meaningfulRoutes.length > 1)
        diagnostics.push(
          error("AMBIGUOUS_ROUTE", `Node ${node.id} has multiple ${outcome} routes`, node.id),
        );
    }
  }
  if (entry && nodeIds.has(entry)) {
    const reachable = new Set<string>([entry]);
    const pending = [entry];
    while (pending.length > 0) {
      const current = pending.pop() as string;
      const currentNode = nodeMap.get(current);
      if (
        currentNode?.kind === "loop" &&
        nodeIds.has((currentNode as import("./contracts").LoopNode).bodyNodeId) &&
        !reachable.has((currentNode as import("./contracts").LoopNode).bodyNodeId)
      ) {
        const bodyNodeId = (currentNode as import("./contracts").LoopNode).bodyNodeId;
        reachable.add(bodyNodeId);
        pending.push(bodyNodeId);
      }
      if (currentNode?.kind === "fork")
        for (const branchId of (currentNode as import("./contracts").ForkNode).branchIds) {
          if (nodeIds.has(branchId) && !reachable.has(branchId)) {
            reachable.add(branchId);
            pending.push(branchId);
          }
        }
      for (const edge of edges.filter((candidate) => candidate.sourceNodeId === current)) {
        if (!reachable.has(edge.targetNodeId)) {
          reachable.add(edge.targetNodeId);
          pending.push(edge.targetNodeId);
        }
      }
    }
    for (const node of nodes)
      if (!reachable.has(node.id))
        diagnostics.push(
          error("UNREACHABLE_NODE", `Node ${node.id} is not reachable from ${entry}`, node.id),
        );
  }
  if (
    hasUnboundedCycle(
      nodes.map((node) => node.id),
      edges,
    )
  )
    diagnostics.push(
      error(
        "UNSUPPORTED_CYCLE",
        "Cycles are unsupported in M1; use a later bounded loop milestone",
      ),
    );

  const definitions: Record<string, Definition> = {};
  if (source.id) {
    const normalizedNodes = [...nodes]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((node) => normalizeNode(node, schemaDigests));
    const normalizedEdges = [...edges]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((edge) => normalizeEdge(edge, schemaDigests));
    const normalizedInputs = (source.inputPorts ?? []).map((port) =>
      normalizePort(port, schemaDigests),
    );
    definitions[source.id] = {
      id: source.id,
      inputPorts: normalizedInputs,
      outputPorts: (source.outputPorts ?? []).map((port) => normalizePort(port, schemaDigests)),
      nodes: normalizedNodes,
      controlEdges: normalizedEdges,
      dataBindings: normalizedNodes.flatMap((node) => node.bindings),
      entry: entry ?? "",
      exits: normalizedNodes.filter((node) => node.kind === "complete").map((node) => node.id),
      counters: [...counters].sort((a, b) => a.id.localeCompare(b.id)),
    };
  }
  for (const child of Object.values(source.definitions ?? {})) {
    const result = await compileWorkflowDetailed(child);
    diagnostics.push(...result.diagnostics);
    if (result.bundle) childBundles.push(result.bundle);
  }
  for (const child of childBundles) {
    for (const [id, definition] of Object.entries(child.definitions)) {
      if (definitions[id])
        diagnostics.push(error("DUPLICATE_DEFINITION", `Duplicate definition ${id}`, id));
      else definitions[id] = definition;
    }
  }

  const boundSummary = summarizeDefinition(
    definitions[source.id ?? ""],
    definitions,
    new Set<string>(),
  );
  if (boundSummary.saturated)
    diagnostics.push(
      error("BOUND_OVERFLOW", "Workflow static bound exceeds configured integer range"),
    );
  if (boundSummary.invocations > limits.maxInvocations)
    diagnostics.push(error("INVOCATION_BOUND", "Workflow bound exceeds maxInvocations"));
  if (boundSummary.scopes > limits.maxScopes)
    diagnostics.push(error("SCOPE_BOUND", "Workflow bound exceeds maxScopes"));
  if (boundSummary.attempts > limits.maxAttempts)
    diagnostics.push(error("ATTEMPT_BOUND", "Workflow bound exceeds maxAttempts"));

  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) return { diagnostics };
  const executable = {
    formatVersion: BUNDLE_FORMAT_VERSION,
    semanticVersions: {
      compiler: COMPILER_VERSION,
      expressions: EXPRESSION_VERSION,
      schemas: SCHEMA_VERSION,
    },
    rootDefinitionId: source.id,
    definitions,
    schemas: sortRecord(schemas),
    limits,
    sourceMap: source.sourceMap ?? {},
    boundSummary,
  };
  let canonicalJson: string;
  try {
    canonicalJson = canonicalize(executable);
  } catch (cause) {
    diagnostics.push(
      error("NON_CANONICAL_SOURCE", cause instanceof Error ? cause.message : String(cause)),
    );
    return { diagnostics };
  }
  const digest = `sha256:${await sha256Hex(canonicalJson)}`;
  const frozenExecutable = deepFreeze(JSON.parse(canonicalJson)) as Omit<
    Bundle,
    "digest" | "canonicalJson"
  >;
  return {
    diagnostics,
    bundle: Object.freeze({ ...frozenExecutable, digest, canonicalJson }) as Bundle,
  };
}

function normalizeLimits(
  input: Partial<ExecutionLimits> | undefined,
  diagnostics: Diagnostic[],
): ExecutionLimits {
  const limits = { ...DEFAULT_LIMITS, ...input } as ExecutionLimits;
  for (const [key, value] of Object.entries(limits)) {
    if (key === "resourceCaps") continue;
    if (!Number.isSafeInteger(value) || value <= 0)
      diagnostics.push(error("INVALID_LIMIT", `${key} must be a positive safe integer`, key));
  }
  for (const [key, value] of Object.entries(limits.resourceCaps ?? {}))
    if (!Number.isSafeInteger(value) || value <= 0)
      diagnostics.push(
        error("INVALID_RESOURCE_CAP", `${key} must be a positive safe integer`, key),
      );
  return Object.freeze(limits);
}

function validatePorts(
  ports: readonly Port[] | undefined,
  schemaDigests: Readonly<Record<string, string>>,
  diagnostics: Diagnostic[],
  subject: string,
): void {
  const seen = new Set<string>();
  for (const port of ports ?? []) {
    if (seen.has(port.name))
      diagnostics.push(error("DUPLICATE_PORT", `Duplicate port ${port.name}`, subject));
    seen.add(port.name);
    if (!schemaDigests[port.schemaDigest])
      diagnostics.push(
        error(
          "MISSING_SCHEMA",
          `No schema supplied for ${port.schemaDigest}`,
          `${subject}.${port.name}`,
        ),
      );
  }
}

function validateBindings(
  bindings: readonly Binding[] | undefined,
  ports: readonly Port[] | undefined,
  nodeMap: ReadonlyMap<string, Node>,
  inputPorts: readonly Port[],
  diagnostics: Diagnostic[],
  subject: string,
): void {
  const targets = new Set((ports ?? []).map((port) => port.name));
  for (const binding of bindings ?? []) {
    if (!targets.has(binding.targetPort))
      diagnostics.push(
        error(
          "UNKNOWN_BINDING_TARGET",
          `Binding targets unknown port ${binding.targetPort}`,
          subject,
        ),
      );
    if (binding.source.kind === "producer" && !nodeMap.has(binding.source.sourceId)) {
      // A producer may be declared later in the source list; this check is
      // repeated after all nodes are collected by the caller's map.
      diagnostics.push(
        error(
          "UNKNOWN_BINDING_PRODUCER",
          `Binding references unknown producer ${binding.source.sourceId}`,
          subject,
        ),
      );
    }
    const inputName = binding.source.kind === "input" ? binding.source.sourceId : undefined;
    if (inputName !== undefined && !inputPorts.some((port) => port.name === inputName)) {
      diagnostics.push(
        error(
          "UNKNOWN_BINDING_INPUT",
          `Binding references unknown workflow input ${inputName}`,
          subject,
        ),
      );
    }
  }
  const boundTargets = new Set((bindings ?? []).map((binding) => binding.targetPort));
  for (const port of ports ?? []) {
    if (port.required && !boundTargets.has(port.name) && port.defaultValue === undefined) {
      diagnostics.push(
        error("MISSING_REQUIRED_BINDING", `Required port ${port.name} has no binding`, subject),
      );
    }
  }
}

function validateBindingSchemas(
  node: Node,
  nodeMap: ReadonlyMap<string, Node>,
  inputPorts: readonly Port[],
  diagnostics: Diagnostic[],
): void {
  const targetPorts = new Map((node.inputPorts ?? []).map((port) => [port.name, port]));
  for (const binding of node.bindings ?? []) {
    const target = targetPorts.get(binding.targetPort);
    if (!target || binding.source.kind === "literal") continue;
    const sourceBinding = binding.source;
    let source: Port | undefined;
    if (sourceBinding.kind === "producer") {
      source = nodeMap
        .get(sourceBinding.sourceId)
        ?.outputPorts.find((port) => port.name === sourceBinding.port);
      if (!source) {
        diagnostics.push(
          error(
            "UNKNOWN_BINDING_PORT",
            `Producer ${sourceBinding.sourceId} has no output port ${sourceBinding.port}`,
            node.id,
          ),
        );
        continue;
      }
    } else if (sourceBinding.kind === "input") {
      source = inputPorts.find((port) => port.name === sourceBinding.sourceId);
    }
    if (source && source.schemaDigest !== target.schemaDigest) {
      diagnostics.push(
        error(
          "BINDING_SCHEMA_MISMATCH",
          `Binding ${binding.targetPort} expects ${target.schemaDigest} but receives ${source.schemaDigest}`,
          `${node.id}.${binding.targetPort}`,
        ),
      );
    }
  }
}

function validateCallInterface(
  node: Extract<Node, { kind: "call" }>,
  child: WorkflowDefinitionSource,
  diagnostics: Diagnostic[],
): void {
  const childInputs = new Map((child.inputPorts ?? []).map((port) => [port.name, port]));
  const childOutputs = new Map((child.outputPorts ?? []).map((port) => [port.name, port]));
  for (const port of node.inputPorts) {
    const expected = childInputs.get(port.name);
    if (!expected)
      diagnostics.push(
        error(
          "CALL_UNKNOWN_INPUT",
          `Call exposes input ${port.name}, but child ${child.id} does not declare it`,
          node.id,
        ),
      );
    else if (expected.schemaDigest !== port.schemaDigest)
      diagnostics.push(
        error(
          "CALL_INPUT_SCHEMA_MISMATCH",
          `Call input ${port.name} does not match child schema`,
          `${node.id}.${port.name}`,
        ),
      );
  }
  for (const port of node.outputPorts) {
    const expected = childOutputs.get(port.name);
    if (!expected)
      diagnostics.push(
        error(
          "CALL_UNKNOWN_OUTPUT",
          `Call exposes output ${port.name}, but child ${child.id} does not declare it`,
          node.id,
        ),
      );
    else if (expected.schemaDigest !== port.schemaDigest)
      diagnostics.push(
        error(
          "CALL_OUTPUT_SCHEMA_MISMATCH",
          `Call output ${port.name} does not match child schema`,
          `${node.id}.${port.name}`,
        ),
      );
  }
  for (const port of childInputs.values())
    if (port.required && !node.inputPorts.some((candidate) => candidate.name === port.name))
      diagnostics.push(
        error(
          "CALL_MISSING_INPUT",
          `Call does not expose required child input ${port.name}`,
          node.id,
        ),
      );
  for (const port of childOutputs.values())
    if (!node.outputPorts.some((candidate) => candidate.name === port.name))
      diagnostics.push(
        error("CALL_MISSING_OUTPUT", `Call does not expose child output ${port.name}`, node.id),
      );
}

function normalizePort(port: Port, schemaDigests: Readonly<Record<string, string>>): Port {
  return {
    name: port.name,
    schemaDigest: schemaDigests[port.schemaDigest] ?? port.schemaDigest,
    required: port.required,
    ...(port.defaultValue === undefined ? {} : { defaultValue: port.defaultValue }),
    ...(port.outcomes === undefined ? {} : { outcomes: port.outcomes }),
  };
}

function normalizeNode(node: Node, schemaDigests: Readonly<Record<string, string>>): Node {
  return {
    ...node,
    inputPorts: node.inputPorts.map((port) => normalizePort(port, schemaDigests)),
    outputPorts: node.outputPorts.map((port) => normalizePort(port, schemaDigests)),
  } as Node;
}

function normalizeEdge(
  edge: Definition["controlEdges"][number],
  _schemaDigests: Readonly<Record<string, string>>,
): Definition["controlEdges"][number] {
  return {
    id: edge.id,
    sourceNodeId: edge.sourceNodeId,
    outcome: edge.outcome,
    targetNodeId: edge.targetNodeId,
    kind: edge.kind,
    ...(edge.guard === undefined ? {} : { guard: edge.guard }),
    ...(edge.default === undefined ? {} : { default: edge.default }),
    ...(edge.counterIncrement === undefined ? {} : { counterIncrement: edge.counterIncrement }),
    ...(edge.feedbackBindings === undefined ? {} : { feedbackBindings: edge.feedbackBindings }),
  };
}

function summarizeDefinition(
  definition: Definition | undefined,
  definitions: Readonly<Record<string, Definition>>,
  active: Set<string>,
): BoundSummary {
  let saturated = false;
  const add = (a: number, b: number) => {
    if (a > SATURATION - b) {
      saturated = true;
      return SATURATION;
    }
    return a + b;
  };
  const multiply = (a: number, b: number) => {
    if (a === 0 || b === 0) return 0;
    if (a > Math.floor(SATURATION / b)) {
      saturated = true;
      return SATURATION;
    }
    return a * b;
  };
  if (!definition) return { scopes: 0, invocations: 0, attempts: 0, saturated: false };
  if (active.has(definition.id))
    return { scopes: SATURATION, invocations: SATURATION, attempts: SATURATION, saturated: true };
  active.add(definition.id);
  let invocations = 0;
  let attempts = 0;
  let scopes = 1;
  for (const node of definition.nodes) {
    invocations = add(invocations, 1);
    if (node.kind === "agent" || node.kind === "command") attempts = add(attempts, 1);
    if (node.kind === "call") {
      const child = summarizeDefinition(
        definitions[(node as import("./contracts").CallNode).definitionId],
        definitions,
        active,
      );
      scopes = add(scopes, child.scopes);
      invocations = add(invocations, child.invocations);
      attempts = add(attempts, child.attempts);
      saturated ||= child.saturated;
    } else if (node.kind === "loop") {
      const loopNode = node as import("./contracts").LoopNode;
      const body = definition.nodes.find((candidate) => candidate.id === loopNode.bodyNodeId);
      if (body) {
        const bodySummary = summarizeNodes([body], definitions, active);
        const multiplier = loopNode.maxIterations;
        scopes = add(scopes, multiplier);
        invocations = add(invocations, multiply(bodySummary.invocations, multiplier));
        attempts = add(attempts, multiply(bodySummary.attempts, multiplier));
        saturated ||= bodySummary.saturated;
      }
    } else if (node.kind === "forEach") {
      const mapNode = node as import("./contracts").ForEachNode;
      const child = summarizeDefinition(
        definitions[mapNode.templateDefinitionId],
        definitions,
        active,
      );
      scopes = add(scopes, mapNode.maxItems === 0 ? 0 : multiply(child.scopes, mapNode.maxItems));
      invocations = add(invocations, multiply(child.invocations, mapNode.maxItems));
      attempts = add(attempts, multiply(child.attempts, mapNode.maxItems));
      saturated ||= child.saturated;
    }
  }
  active.delete(definition.id);
  return {
    scopes,
    invocations,
    attempts,
    saturated,
  };
}

function summarizeNodes(
  nodes: readonly Node[],
  definitions: Readonly<Record<string, Definition>>,
  active: Set<string>,
): BoundSummary {
  const synthetic: Definition = {
    id: "__summary__",
    inputPorts: [],
    outputPorts: [],
    nodes,
    controlEdges: [],
    dataBindings: [],
    entry: "",
    exits: [],
    counters: [],
  };
  return summarizeDefinition(synthetic, definitions, active);
}

function validateStructuralTopology(
  nodes: readonly Node[],
  edges: readonly ControlEdge[],
  nodeMap: ReadonlyMap<string, Node>,
  diagnostics: Diagnostic[],
): void {
  const forks = nodes.filter(
    (candidate): candidate is Extract<Node, { kind: "fork" }> => candidate.kind === "fork",
  );
  const joins = nodes.filter(
    (candidate): candidate is Extract<Node, { kind: "join" }> => candidate.kind === "join",
  );
  const owners = new Map<string, string>();
  for (const fork of forks) {
    if (new Set(fork.branchIds).size !== fork.branchIds.length)
      diagnostics.push(
        error(
          "DUPLICATE_PARALLEL_BRANCH",
          `Fork ${fork.id} declares a branch more than once`,
          fork.id,
        ),
      );
    for (const branchId of fork.branchIds) {
      const branch = nodeMap.get(branchId);
      if (!branch) {
        diagnostics.push(
          error(
            "UNKNOWN_PARALLEL_BRANCH",
            `Fork ${fork.id} references unknown branch ${branchId}`,
            fork.id,
          ),
        );
        continue;
      }
      const previous = owners.get(branchId);
      if (previous && previous !== fork.groupId)
        diagnostics.push(
          error(
            "PARALLEL_BRANCH_OWNERSHIP",
            `Branch ${branchId} belongs to multiple fork groups`,
            branchId,
          ),
        );
      owners.set(branchId, fork.groupId);
    }
    if (joins.filter((candidate) => candidate.groupId === fork.groupId).length !== 1)
      diagnostics.push(
        error(
          "PARALLEL_JOIN_CARDINALITY",
          `Fork ${fork.id} must have exactly one matching join`,
          fork.id,
        ),
      );
  }
  for (const join of joins) {
    const fork = forks.find((candidate) => candidate.groupId === join.groupId);
    if (!fork) {
      diagnostics.push(
        error("ORPHAN_JOIN", `Join ${join.id} has no matching fork group ${join.groupId}`, join.id),
      );
      continue;
    }
    for (const branchId of fork.branchIds) {
      if (!nodeMap.has(branchId) || !canReach(branchId, join.id, edges))
        diagnostics.push(
          error(
            "PARALLEL_BRANCH_NO_CONVERGENCE",
            `Branch ${branchId} cannot reach join ${join.id}`,
            branchId,
          ),
        );
    }
  }
}

function canReach(start: string, target: string, edges: readonly ControlEdge[]): boolean {
  const seen = new Set<string>();
  const pending = [start];
  while (pending.length) {
    const current = pending.pop() as string;
    if (current === target) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const edge of edges) if (edge.sourceNodeId === current) pending.push(edge.targetNodeId);
  }
  return false;
}

function sortRecord<T>(record: Readonly<Record<string, T>>): Record<string, T> {
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, record[key]]),
  );
}

function error(code: string, message: string, subject?: string): Diagnostic {
  return { code, message, ...(subject === undefined ? {} : { subject }), severity: "error" };
}

function hasUnboundedCycle(
  nodeIds: readonly string[],
  edges: readonly { sourceNodeId: string; targetNodeId: string; counterIncrement?: string }[],
): boolean {
  const adjacency = new Map<string, string[]>();
  for (const id of nodeIds) adjacency.set(id, []);
  // A guarded increment edge is the sole permitted cycle breaker. Removing
  // every such edge leaves the residual graph; any cycle in that graph is
  // unbounded because it can be traversed without consuming a monotonic bound.
  for (const edge of edges)
    if (edge.counterIncrement === undefined)
      adjacency.get(edge.sourceNodeId)?.push(edge.targetNodeId);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const target of adjacency.get(id) ?? []) if (visit(target)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return nodeIds.some((id) => visit(id));
}

function isSupportedGuard(value: JsonValue, counters: ReadonlySet<string>): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const guard = value as Record<string, JsonValue>;
  return (
    guard.kind === "counter-below-limit" &&
    typeof guard.counterId === "string" &&
    counters.has(guard.counterId)
  );
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
