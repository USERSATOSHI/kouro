import {
  Table,
  Badge,
  Box,
  Button,
  Group,
  List,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Textarea,
  Title,
} from "@mantine/core";
import { Disclosure, DisclosureTitle } from "./components/Disclosure";
import { useEffect, useState, type FormEvent } from "react";

/** Web-facing M7 DTOs. These deliberately do not import host storage types. */
export type M7EligibilityReason = string;
export type EligibilityPredicate = {
  id: string;
  label: string;
  satisfied: boolean;
  detail: string;
};
export type CheckpointEligibilityView = {
  eligible: boolean;
  predicates: EligibilityPredicate[];
  reasons: M7EligibilityReason[];
  pendingFrontierAllowed: boolean;
};
export type CheckpointView = {
  id: string;
  sourceRunId: string;
  sourceRevision?: number;
  sourceEventCursor?: number;
  certificateDigest?: string;
  treeDigest?: string;
  inheritedInvocationIds: string[];
  pendingInvocationIds: string[];
};
export type GenealogyNode = {
  runId: string;
  label: string;
  parentRunId?: string;
  checkpointId?: string;
  status?: string;
  createdAt?: string;
  children: string[];
  inheritedInvocationIds: string[];
};
export type GenealogyView = { rootRunId?: string; nodes: GenealogyNode[] };
export type ComparisonEntry = {
  invocationId: string;
  label: string;
  status: "inherited" | "new" | "missing" | "unknown";
  sourceInvocationId?: string;
  durationMs?: number;
  cost?: number;
  durationKnown: boolean;
  costKnown: boolean;
  detail?: string;
};
export type PrefixComparison = {
  inheritedCount: number;
  newCount: number;
  missingCount: number;
  unknownCount: number;
  inheritedDurationMs?: number;
  newDurationMs?: number;
  inheritedCost?: number;
  newCost?: number;
  entries: ComparisonEntry[];
};
export type M7TimelineItem = {
  id: string;
  label: string;
  phase: "inherited" | "new" | "missing" | "unknown";
  durationMs?: number;
  cost?: number;
  detail?: string;
};
export type M7Timeline = { items: M7TimelineItem[] };
export type M7View = {
  runId: string;
  eligibility: CheckpointEligibilityView;
  checkpoint?: CheckpointView;
  genealogy: GenealogyView;
  comparison: PrefixComparison;
  timeline: M7Timeline;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const bool = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

const REASON_LABELS: Record<string, string> = {
  "admission-not-paused": "Admission is paused",
  "run-not-paused": "Run is paused",
  "active-effect": "No effect is active",
  "reserved-effect": "No effect is reserved",
  "claimed-effect": "No effect is claimed",
  "unknown-effect": "Effect state is known",
  "active-outbox": "Outbox is drained",
  "unknown-outbox": "Outbox state is known",
  "effect-writer": "No effect writer is active",
  "live-session-lease": "No live provider session lease remains",
  "recovery-required": "Run does not require recovery",
  "unresolved-reconciliation": "External effects are reconciled",
  "unverified-artifacts": "Artifact closure is verified",
  "unverified-workspace": "Workspace is verified",
  "missing-workspace-tree": "Workspace tree is retained",
  "invalid-revision": "Revision is valid",
  "unsupported-nested-scope": "Nested invocation reuse is supported",
};
const humanReason = (reason: string) =>
  REASON_LABELS[reason] ?? reason.replaceAll("-", " ").replace(/^./, (x) => x.toUpperCase());

/** Normalize a host certificate or a sparse fixture without asserting eligibility. */
export function normalizeEligibility(raw: unknown): CheckpointEligibilityView {
  const root = asRecord(raw);
  const envelope = asRecord(root.eligibility ?? root);
  // The host returns `{ eligibility: { eligible, reasons }, predicates }`.
  // Fixtures may pass the certificate directly, so accept both envelopes.
  const source = asRecord(envelope.eligibility ?? envelope);
  const reasons = asList(source.reasons).map(String);
  const suppliedPredicates = asList(envelope.predicates ?? source.predicates ?? source.checks);
  const predicates: EligibilityPredicate[] = suppliedPredicates.map((value, index) => {
    const item = asRecord(value);
    const id = text(item.id ?? item.reason) ?? `predicate-${index + 1}`;
    const satisfied = bool(item.satisfied ?? item.ok ?? item.eligible) ?? !reasons.includes(id);
    return {
      id,
      label: text(item.label) ?? humanReason(id),
      satisfied,
      detail: text(item.detail ?? item.message) ?? (satisfied ? "confirmed" : `blocked by ${id}`),
    };
  });
  for (const reason of reasons) {
    if (!predicates.some((predicate) => predicate.id === reason))
      predicates.push({
        id: reason,
        label: humanReason(reason),
        satisfied: false,
        detail: "host reported this predicate as unsatisfied",
      });
  }
  // A missing host field is not an eligibility certificate. Actions stay disabled
  // until the host explicitly reports true, even when a sparse fixture has no reasons.
  const eligible =
    source.eligible === true && reasons.length === 0 && predicates.every((item) => item.satisfied);
  return {
    eligible,
    predicates,
    reasons,
    pendingFrontierAllowed: bool(source.pendingFrontierAllowed) ?? true,
  };
}

export function normalizeCheckpoint(
  raw: unknown,
  fallbackRunId: string,
): CheckpointView | undefined {
  const root = asRecord(raw);
  const item = asRecord(root.checkpoint ?? root.cut ?? (root.id ? root : undefined));
  const id = text(item.checkpointId ?? item.id);
  if (!id) return undefined;
  return {
    id,
    sourceRunId: text(item.sourceRunId ?? item.runId) ?? fallbackRunId,
    sourceRevision: number(item.sourceRevision ?? item.revision),
    sourceEventCursor: number(item.sourceEventCursor ?? item.eventCursor),
    certificateDigest: text(item.certificateDigest),
    treeDigest: text(item.workspaceTreeDigest ?? item.treeDigest),
    inheritedInvocationIds: asList(
      item.inheritedSourceInvocationIds ?? item.inheritedInvocationIds,
    ).map(String),
    pendingInvocationIds: asList(item.pendingFrontier).map(
      (entry) => text(asRecord(entry).invocationId) ?? String(entry),
    ),
  };
}

export function normalizeGenealogy(raw: unknown): GenealogyView {
  const root = asRecord(raw);
  const source = raw && Array.isArray(raw) ? { nodes: raw } : asRecord(root.genealogy ?? root);
  const values = asList(source.nodes ?? source.items ?? source.runs);
  const nodes = values.map((value) => {
    const item = asRecord(value);
    const runId = text(item.runId ?? item.id) ?? "unknown-run";
    return {
      runId,
      label: text(item.label ?? item.name) ?? runId,
      parentRunId: text(item.parentRunId ?? item.parentId),
      checkpointId: text(item.checkpointId),
      status: text(item.status ?? item.state),
      createdAt: text(item.createdAt),
      children: asList(item.children ?? item.childRunIds).map((child) =>
        typeof child === "string"
          ? child
          : (text(asRecord(child).runId ?? asRecord(child).id) ?? String(child)),
      ),
      inheritedInvocationIds: asList(
        item.inheritedInvocationIds ?? item.inheritedSourceInvocationIds,
      ).map(String),
    } satisfies GenealogyNode;
  });
  // Hosts may return parent links only; make the tree useful without fabricating runs.
  const byId = new Map(nodes.map((node) => [node.runId, node]));
  for (const node of nodes) {
    if (
      node.parentRunId &&
      byId.has(node.parentRunId) &&
      !byId.get(node.parentRunId)!.children.includes(node.runId)
    )
      byId.get(node.parentRunId)!.children.push(node.runId);
  }
  return {
    rootRunId: text(source.rootRunId) ?? nodes.find((node) => !node.parentRunId)?.runId,
    nodes,
  };
}

const phase = (value: unknown): ComparisonEntry["status"] =>
  value === "inherited" || value === "new" || value === "missing" || value === "unknown"
    ? value
    : "unknown";
export function normalizeComparison(raw: unknown): PrefixComparison {
  const root = asRecord(raw);
  const source = asRecord(root.comparison ?? root);
  const entries = asList(source.entries ?? source.items ?? source.rows).map((value, index) => {
    const item = asRecord(value);
    const status = phase(item.status ?? item.phase ?? item.provenance);
    const durationMs = number(item.durationMs ?? item.elapsedMs);
    const cost = number(item.cost);
    return {
      invocationId: text(item.invocationId ?? item.id) ?? `entry-${index + 1}`,
      label:
        text(item.label ?? item.name) ?? text(item.invocationId ?? item.id) ?? `stage ${index + 1}`,
      status,
      sourceInvocationId: text(item.sourceInvocationId),
      durationMs,
      cost,
      durationKnown: durationMs !== undefined,
      costKnown: cost !== undefined,
      detail: text(item.detail ?? item.reason),
    } satisfies ComparisonEntry;
  });
  const sum = (status: ComparisonEntry["status"], key: "durationMs" | "cost") => {
    const values = entries
      .filter((entry) => entry.status === status)
      .map((entry) => entry[key])
      .filter((x): x is number => x !== undefined);
    return values.length ? values.reduce((total, value) => total + value, 0) : undefined;
  };
  const count = (status: ComparisonEntry["status"], key: string) =>
    entries.length
      ? entries.filter((entry) => entry.status === status).length
      : (number(source[key]) ?? 0);
  return {
    inheritedCount: count("inherited", "inheritedCount"),
    newCount: count("new", "newCount"),
    missingCount: count("missing", "missingCount"),
    unknownCount: count("unknown", "unknownCount"),
    inheritedDurationMs: number(source.inheritedDurationMs) ?? sum("inherited", "durationMs"),
    newDurationMs: number(source.newDurationMs) ?? sum("new", "durationMs"),
    inheritedCost: number(source.inheritedCost) ?? sum("inherited", "cost"),
    newCost: number(source.newCost) ?? sum("new", "cost"),
    entries,
  };
}

export function normalizeM7View(raw: unknown, runId: string): M7View {
  const root = asRecord(raw);
  const comparison = normalizeComparison(root.comparison);
  const timelineRoot = asRecord(root.timeline);
  const timeline: M7Timeline = {
    items: asList(timelineRoot.items ?? timelineRoot.events).map((value, index) => {
      const item = asRecord(value);
      return {
        id: text(item.id) ?? `timeline-${index + 1}`,
        label: text(item.label ?? item.name) ?? `stage ${index + 1}`,
        phase: phase(item.phase ?? item.status ?? item.provenance),
        durationMs: number(item.durationMs ?? item.elapsedMs),
        cost: number(item.cost),
        detail: text(item.detail ?? item.reason),
      };
    }),
  };
  if (!timeline.items.length)
    timeline.items = comparison.entries.map((entry) => ({
      id: entry.invocationId,
      label: entry.label,
      phase: entry.status,
      durationMs: entry.durationMs,
      cost: entry.cost,
      detail: entry.detail,
    }));
  return {
    runId,
    eligibility: normalizeEligibility(root.eligibility ?? root.certificate),
    checkpoint: normalizeCheckpoint(root.checkpoint ?? root.cut, runId),
    genealogy: normalizeGenealogy(root.genealogy),
    comparison,
    timeline,
  };
}

export const M7_FIXTURE: M7View = normalizeM7View(
  {
    eligibility: {
      eligible: true,
      predicates: [
        {
          id: "run-not-paused",
          label: "Run is paused",
          satisfied: true,
          detail: "paused at revision 7",
        },
        {
          id: "active-effect",
          label: "No effect is active",
          satisfied: true,
          detail: "effect queue drained",
        },
        {
          id: "unverified-workspace",
          label: "Workspace is verified",
          satisfied: true,
          detail: "tree-a retained",
        },
      ],
      pendingFrontierAllowed: true,
    },
    checkpoint: {
      checkpointId: "cp-1",
      sourceRunId: "run-parent",
      sourceRevision: 7,
      inheritedSourceInvocationIds: ["inv-1", "inv-2"],
      pendingFrontier: [{ invocationId: "inv-3" }],
    },
    genealogy: {
      rootRunId: "run-parent",
      nodes: [
        {
          runId: "run-parent",
          label: "parent",
          children: ["run-child-a", "run-child-b"],
          inheritedInvocationIds: [],
        },
        {
          runId: "run-child-a",
          label: "approach A",
          parentRunId: "run-parent",
          checkpointId: "cp-1",
          children: [],
          inheritedInvocationIds: ["inv-1", "inv-2"],
        },
        {
          runId: "run-child-b",
          label: "approach B",
          parentRunId: "run-parent",
          checkpointId: "cp-1",
          children: [],
          inheritedInvocationIds: ["inv-1", "inv-2"],
        },
      ],
    },
    comparison: {
      entries: [
        { invocationId: "inv-1", label: "plan", status: "inherited", durationMs: 1200, cost: 0.01 },
        { invocationId: "inv-2", label: "inspect", status: "inherited", durationMs: 2300 },
        { invocationId: "inv-3", label: "implement", status: "new", durationMs: 5400, cost: 0.04 },
        {
          invocationId: "inv-4",
          label: "provider",
          status: "unknown",
          detail: "host did not report usage",
        },
      ],
    },
  },
  "run-child-a",
);

export const M7_ENDPOINTS = {
  view: (runId: string) => `/api/runs/${encodeURIComponent(runId)}/checkpoint`,
  checkpoint: (runId: string) => `/api/runs/${encodeURIComponent(runId)}/checkpoints`,
  fork: (checkpointId: string) => `/api/checkpoints/${encodeURIComponent(checkpointId)}/forks`,
  genealogy: (runId: string) => `/api/runs/${encodeURIComponent(runId)}/genealogy`,
};

export type M7WorkbenchProps = {
  compact?: boolean;
  runId: string;
  revision?: number;
  fetchView: (runId: string) => Promise<unknown>;
  createCheckpoint?: (runId: string) => Promise<unknown>;
  forkCheckpoint?: (
    checkpointId: string,
    input: { name: string; promptVariants?: Record<string, string> },
  ) => Promise<unknown>;
};
const metric = (value: number | undefined, unit: string) =>
  value === undefined ? "unknown" : `${value}${unit}`;
const statusText = (entry: ComparisonEntry) =>
  entry.status === "missing" ? "missing" : entry.status === "unknown" ? "unknown" : entry.status;

export function M7Workbench({
  runId,
  revision,
  fetchView,
  createCheckpoint,
  forkCheckpoint,
  compact = false,
}: M7WorkbenchProps) {
  const [view, setView] = useState<M7View>();
  const [error, setError] = useState<string>();
  const [name, setName] = useState("");
  const [promptNodeId, setPromptNodeId] = useState("");
  const [promptText, setPromptText] = useState("");
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void fetchView(runId)
      .then((raw) => {
        if (!cancelled) {
          setView(normalizeM7View(raw, runId));
          setError(undefined);
        }
      })
      .catch((cause) => {
        if (!cancelled)
          setError(cause instanceof Error ? cause.message : "Checkpoint data unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, [fetchView, runId, revision]);
  if (error)
    return (
      <Stack
        gap="xs"
        component="section"
        p={compact ? 0 : { base: "sm", md: "lg" }}
        className="m7-workbench"
        role="status"
      >
        <Text component="span" size="sm" c="dimmed" className="eyebrow">
          CHECKPOINTS
        </Text>
        <Title order={1}>Checkpoint data unavailable</Title>
        <Text size="sm">{error}</Text>
      </Stack>
    );
  if (!view)
    return (
      <Stack
        gap="xs"
        component="section"
        p={compact ? 0 : { base: "sm", md: "lg" }}
        className="m7-workbench"
        role="status"
      >
        <Text component="span" size="sm" className="loader" /> Loading checkpoint state…
      </Stack>
    );
  const eligible = view.eligibility.eligible;
  const checkpoint = view.checkpoint;
  const onCheckpoint = async () => {
    if (!createCheckpoint || !eligible) return;
    setBusy(true);
    setNotice(undefined);
    try {
      const raw = await createCheckpoint(runId);
      setView(normalizeM7View(raw, runId));
      setNotice("Checkpoint captured.");
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "Unable to capture checkpoint");
    } finally {
      setBusy(false);
    }
  };
  const onFork = async (event: FormEvent) => {
    event.preventDefault();
    if (!forkCheckpoint || !eligible || !checkpoint || !name.trim()) return;
    if (Boolean(promptNodeId.trim()) !== Boolean(promptText.trim())) {
      setNotice("Provide both an unexecuted agent node ID and its replacement prompt.");
      return;
    }
    setBusy(true);
    setNotice(undefined);
    try {
      const raw = await forkCheckpoint(checkpoint.id, {
        name: name.trim(),
        ...(promptNodeId.trim() ? { promptVariants: { [promptNodeId.trim()]: promptText } } : {}),
      });
      setView(normalizeM7View(raw, runId));
      setName("");
      setNotice("Fork requested.");
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "Unable to create fork");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Stack
      gap="xs"
      component="section"
      p={compact ? 0 : { base: "sm", md: "lg" }}
      className="m7-workbench"
    >
      {!compact && (
        <Group
          gap="xs"
          justify="space-between"
          wrap="wrap"
          component="header"
          className="m7-header"
        >
          <Stack gap="xs">
            <Text component="span" size="sm" c="dimmed" className="eyebrow">
              CHECKPOINTS & FORKS
            </Text>
            <Title order={1}>Safe cut and genealogy</Title>
            <Text size="sm">Inspect the retained frontier before reusing work in a child run.</Text>
          </Stack>
          <Stack
            gap="xs"
            className={`m7-eligibility-badge ${eligible ? "eligible" : "ineligible"}`}
            role="status"
          >
            {eligible ? "eligible" : "ineligible"}
          </Stack>
        </Group>
      )}
      {notice && (
        <Stack gap="xs" className="notice" role="status">
          {notice}
        </Stack>
      )}
      <SimpleGrid
        cols={{ base: 1, md: compact ? 1 : 2 }}
        spacing="md"
        component="section"
        className="m7-grid"
      >
        <Paper component="article" className="m7-panel m7-eligibility">
          <Stack gap="md">
            <Group gap="sm" justify="space-between" mb="md" className="m7-panel-heading">
              <Text component="span" size="sm" fw={600}>
                CHECKPOINT ELIGIBILITY
              </Text>
              <Text component="span" size="sm">
                {eligible
                  ? "All host predicates satisfied"
                  : "Resolve every predicate before capture"}
              </Text>
            </Group>
            <List>
              {view.eligibility.predicates.map((predicate) => (
                <List.Item
                  key={predicate.id}
                  className={predicate.satisfied ? "satisfied" : "blocked"}
                >
                  <Text component="span" size="sm" aria-hidden="true">
                    {predicate.satisfied ? "✓" : "×"}
                  </Text>
                  <Stack gap="xs">
                    <Text component="span" size="sm" fw={600}>
                      {predicate.label}
                    </Text>
                    <Text component="span" size="xs" c="dimmed">
                      {predicate.detail}
                    </Text>
                  </Stack>
                </List.Item>
              ))}
            </List>
            {view.eligibility.reasons.length > 0 && (
              <Text size="sm" className="m7-hint">
                Blocked by: {view.eligibility.reasons.map(humanReason).join(", ")}
              </Text>
            )}
            <Button
              variant="filled"
              className="primary-button"
              disabled={!eligible || !createCheckpoint || busy}
              onClick={() => void onCheckpoint()}
            >
              Capture checkpoint
            </Button>
          </Stack>
        </Paper>
        <Paper component="article" className="m7-panel">
          <Stack gap="md">
            <Group gap="sm" justify="space-between" mb="md" className="m7-panel-heading">
              <Text component="span" size="sm" fw={600}>
                FORK FROM CHECKPOINT
              </Text>
              <Text component="span" size="sm">
                {checkpoint ? `source ${checkpoint.id}` : "Capture a checkpoint first"}
              </Text>
            </Group>
            <Stack
              gap="xs"
              component="form"
              className="m7-fork-form"
              onSubmit={(event) => void onFork(event)}
            >
              <Stack gap={4} component="label">
                Child run name
                <TextInput
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="e.g. approach-b"
                  disabled={!eligible || !checkpoint || busy}
                />
              </Stack>
              <Disclosure className="m7-prompt-variant">
                <DisclosureTitle>Change an unexecuted agent prompt</DisclosureTitle>
                <Text size="sm" className="m7-hint">
                  Enter a node ID from the compiled graph. Completed nodes and graph changes are
                  rejected before the fork is created.
                </Text>
                <Stack gap={4} component="label">
                  Agent node ID
                  <TextInput
                    value={promptNodeId}
                    onChange={(event) => setPromptNodeId(event.target.value)}
                    placeholder="implement"
                    disabled={!eligible || !checkpoint || busy}
                  />
                </Stack>
                <Stack gap={4} component="label">
                  Replacement prompt
                  <Textarea
                    minRows={3}
                    autosize
                    maxRows={12}
                    value={promptText}
                    onChange={(event) => setPromptText(event.target.value)}
                    disabled={!eligible || !checkpoint || busy}
                  />
                </Stack>
              </Disclosure>
              <Button
                variant="filled"
                className="primary-button"
                type="submit"
                disabled={!eligible || !checkpoint || !forkCheckpoint || !name.trim() || busy}
              >
                Create isolated fork
              </Button>
              <Text size="sm" className="m7-hint">
                Approvals and provider sessions are fresh; inherited results have no authority.
              </Text>
            </Stack>
          </Stack>
        </Paper>
      </SimpleGrid>
      {!compact && (
        <>
          <Paper component="section" className="m7-panel m7-genealogy">
            <Stack gap="md">
              <Group gap="sm" justify="space-between" mb="md" className="m7-panel-heading">
                <Text component="span" size="sm" fw={600}>
                  GENEALOGY
                </Text>
                <Text component="span" size="sm">
                  Parent → checkpoint → child runs
                </Text>
              </Group>
              <Stack gap="xs" className="m7-tree" role="tree">
                {view.genealogy.nodes.map((node) => (
                  <Stack
                    gap="xs"
                    className={`m7-tree-node ${node.runId === runId ? "current" : ""}`}
                    key={node.runId}
                    role="treeitem"
                    aria-level={node.parentRunId ? 2 : 1}
                  >
                    <Text component="span" size="sm" className="m7-tree-marker">
                      {node.parentRunId ? "└" : "●"}
                    </Text>
                    <Stack gap="xs">
                      <Text component="span" size="sm" fw={600}>
                        {node.label}
                      </Text>
                      <Text component="span" size="xs" c="dimmed">
                        {node.runId}
                        {node.checkpointId ? ` · via ${node.checkpointId}` : ""}
                      </Text>
                    </Stack>
                    <Text component="span" size="sm" c="dimmed">
                      {node.inheritedInvocationIds.length} inherited
                    </Text>
                  </Stack>
                ))}
              </Stack>
            </Stack>
          </Paper>
          <Paper component="section" className="m7-panel m7-comparison">
            <Stack gap="md">
              <Group gap="sm" justify="space-between" mb="md" className="m7-panel-heading">
                <Text component="span" size="sm" fw={600}>
                  INHERITED PREFIX VS NEW WORK
                </Text>
                <Text component="span" size="sm">
                  Inherited work is lineage evidence, not new spend.
                </Text>
              </Group>
              <SimpleGrid cols={{ base: 1, md: 3 }} spacing="md" className="m7-metrics">
                <Stack gap="xs">
                  <Text component="span" size="xs" c="dimmed">
                    Inherited
                  </Text>
                  <Text component="span" size="sm" fw={600}>
                    {view.comparison.inheritedCount} ·{" "}
                    {metric(view.comparison.inheritedDurationMs, "ms")} ·{" "}
                    {metric(view.comparison.inheritedCost, " cost")}
                  </Text>
                </Stack>
                <Stack gap="xs">
                  <Text component="span" size="xs" c="dimmed">
                    New
                  </Text>
                  <Text component="span" size="sm" fw={600}>
                    {view.comparison.newCount} · {metric(view.comparison.newDurationMs, "ms")} ·{" "}
                    {metric(view.comparison.newCost, " cost")}
                  </Text>
                </Stack>
                <Stack gap="xs">
                  <Text component="span" size="xs" c="dimmed">
                    Unresolved
                  </Text>
                  <Text component="span" size="sm" fw={600}>
                    {view.comparison.missingCount + view.comparison.unknownCount}
                  </Text>
                </Stack>
              </SimpleGrid>
              <Table.ScrollContainer minWidth={450}>
                <Table>
                  <Table.Thead>
                    <Table.Tr>
                      {["Stage", "Provenance", "Duration", "Provider cost"].map((label) => (
                        <Table.Th key={label}>{label}</Table.Th>
                      ))}
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {view.comparison.entries.map((entry) => (
                      <Table.Tr key={entry.invocationId}>
                        <Table.Td>{entry.label}</Table.Td>
                        <Table.Td>
                          <Badge variant="light">{statusText(entry)}</Badge>
                        </Table.Td>
                        <Table.Td>{metric(entry.durationMs, "ms")}</Table.Td>
                        <Table.Td>{metric(entry.cost, "")}</Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            </Stack>
          </Paper>
          <Paper component="section" className="m7-panel m7-timeline">
            <Stack gap="md">
              <Group gap="sm" justify="space-between" mb="md" className="m7-panel-heading">
                <Text component="span" size="sm" fw={600}>
                  TIMELINE
                </Text>
                <Text component="span" size="sm">
                  Unknown and missing host telemetry remain visible.
                </Text>
              </Group>
              <Stack gap="xs" className="m7-timeline-list">
                {view.timeline.items.map((item) => (
                  <Stack gap="xs" className={`m7-timeline-item m7-${item.phase}`} key={item.id}>
                    <Text component="span" size="sm" className="m7-timeline-dot" />
                    <Text component="span" size="sm" fw={600}>
                      {item.label}
                    </Text>
                    <Text component="span" size="sm">
                      {statusText({
                        ...item,
                        status: item.phase,
                        invocationId: item.id,
                        durationKnown: item.durationMs !== undefined,
                        costKnown: item.cost !== undefined,
                      })}
                    </Text>
                    <Text component="span" size="xs" c="dimmed">
                      {metric(item.durationMs, "ms")} · {metric(item.cost, " cost")}
                      {item.detail ? ` · ${item.detail}` : ""}
                    </Text>
                  </Stack>
                ))}
              </Stack>
            </Stack>
          </Paper>
        </>
      )}
    </Stack>
  );
}
