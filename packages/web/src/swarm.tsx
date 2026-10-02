import type { ReactNode } from "react";
import type { UiRunView } from "./types";
import { asArray } from "./types";
import { PageHeader } from "./components/WorkbenchPrimitives";
import { Disclosure, DisclosureTitle } from "./components/Disclosure";
import {
  Alert,
  Anchor,
  Badge,
  Grid,
  NavLink,
  Progress,
  ScrollArea,
  ThemeIcon,
} from "@mantine/core";
import { stateColor } from "./theme";
import { Button, Code, Group, Loader, Paper, Stack, Text, Title } from "@mantine/core";
import { useEffect, useState } from "react";
import { isHarness } from "@kouro/core";
import type { RuntimeHarness } from "@kouro/core";
import { SafeMarkdown } from "./components/AgentSession";

export type SwarmParticipant = {
  id: string;
  name: string;
  role: string;
  harness?: RuntimeHarness;
  model?: string;
  state: string;
  activity?: string;
  joinedAt?: string;
  lastActiveAt?: string;
};
export type SwarmMessage = {
  id: string;
  channelId: string;
  senderId: string;
  recipientIds: string[];
  body: string;
  type?: string;
  createdAt?: string;
  turn?: number;
  attemptId?: string;
  senderAttemptId?: string;
  recipientContextIds?: string[];
  delivery?: string;
};
export type SwarmChannel = { id: string; name: string; kind?: string; participantIds: string[] };
export type SwarmBlackboardEntry = {
  id: string;
  type: string;
  title: string;
  body: string;
  authorId?: string;
  createdAt?: string;
  status?: string;
};
export type SwarmArtifact = {
  id: string;
  name: string;
  kind?: string;
  contentType?: string;
  size?: number;
  producerId?: string;
  uri?: string;
};
export type SwarmBudget = {
  messageTurns?: { used: number; limit: number };
  messages?: { used: number; limit: number };
  elapsedMs?: { used: number; limit: number };
};
export type SwarmTimelineEvent = {
  id: string;
  participantId: string;
  type: string;
  label: string;
  at: string;
  messageId?: string;
  attemptId?: string;
};
export type CollaborationView = {
  runId: string;
  objective: string;
  startedAt?: string;
  idleDeadline?: string;
  budgets: SwarmBudget;
  participants: SwarmParticipant[];
  channels: SwarmChannel[];
  messages: SwarmMessage[];
  blackboard: SwarmBlackboardEntry[];
  artifacts: SwarmArtifact[];
  timeline: SwarmTimelineEvent[];
  results: Array<{
    id: string;
    participantId: string;
    title: string;
    body: string;
    final: boolean;
  }>;
};

const text = (value: unknown, fallback = "") => (typeof value === "string" ? value : fallback);
const num = (value: unknown, fallback = 0) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
const list = (value: unknown) => (Array.isArray(value) ? value : []);
const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

/** Converts the host's durable collaboration envelope without inventing provider capabilities. */
export function normalizeCollaboration(raw: unknown, runId: string): CollaborationView {
  const root = obj(raw);
  const budget = obj(root.budgets ?? root.budget);
  const pair = (key: string) => {
    const value = obj(budget[key]);
    return { used: num(value.used), limit: num(value.limit) };
  };
  return {
    runId: text(root.runId, runId),
    objective: text(root.objective, "No objective recorded"),
    startedAt: text(root.startedAt) || undefined,
    idleDeadline: text(root.idleDeadline) || undefined,
    budgets: {
      messageTurns: pair("messageTurns"),
      messages: pair("messages"),
      elapsedMs: pair("elapsedMs"),
    },
    participants: list(root.participants).map((value) => {
      const x = obj(value);
      const rawHarness = text(x.harness);
      return {
        id: text(x.id),
        name: text(x.name, text(x.id, "participant")),
        role: text(x.role, "participant"),
        harness: isHarness(rawHarness)
          ? rawHarness
          : rawHarness === "scripted"
            ? rawHarness
            : undefined,
        model: text(x.model) || undefined,
        state: text(x.state, "unknown"),
        activity: text(x.activity) || undefined,
        joinedAt: text(x.joinedAt) || undefined,
        lastActiveAt: text(x.lastActiveAt) || undefined,
      };
    }),
    channels: list(root.channels).map((value) => {
      const x = obj(value);
      return {
        id: text(x.id),
        name: text(x.name, text(x.id, "channel")),
        kind: text(x.kind) || undefined,
        participantIds: list(x.participantIds).map(String),
      };
    }),
    messages: list(root.messages).map((value) => {
      const x = obj(value);
      return {
        id: text(x.id),
        channelId: text(x.channelId),
        senderId: text(x.senderId),
        recipientIds: list(x.recipientIds).map(String),
        body: text(x.body, text(x.content)),
        type: text(x.type) || undefined,
        createdAt: text(x.createdAt) || undefined,
        turn: typeof x.turn === "number" ? x.turn : undefined,
        attemptId: text(x.attemptId) || undefined,
        senderAttemptId: text(x.senderAttemptId) || undefined,
        recipientContextIds: list(x.recipientContextIds).map(String),
        delivery: text(x.delivery) || undefined,
      };
    }),
    blackboard: list(root.blackboard).map((value) => {
      const x = obj(value);
      return {
        id: text(x.id),
        type: text(x.type, text(x.channelId).replace(/^blackboard:/, "") || "finding"),
        title: text(x.title, "Shared finding"),
        body: text(x.body, text(x.content)),
        authorId: text(x.authorId, text(x.senderId)) || undefined,
        createdAt: text(x.createdAt) || undefined,
        status: text(x.status) || undefined,
      };
    }),
    artifacts: list(root.artifacts).map((value) => {
      const x = obj(value);
      return {
        id: text(x.id),
        name: text(x.name, text(x.id, "artifact")),
        kind: text(x.kind) || undefined,
        contentType: text(x.contentType) || undefined,
        size: typeof x.size === "number" ? x.size : undefined,
        producerId: text(x.producerId) || undefined,
        uri: text(x.uri) || undefined,
      };
    }),
    timeline: list(root.timeline).map((value) => {
      const x = obj(value);
      return {
        id: text(x.id),
        participantId: text(x.participantId),
        type: text(x.type, "event"),
        label: text(x.label, text(x.type, "event")),
        at: text(x.at, text(x.createdAt)),
        messageId: text(x.messageId) || undefined,
        attemptId: text(x.attemptId) || undefined,
      };
    }),
    results: list(root.results).map((value) => {
      const x = obj(value);
      return {
        id: text(x.id),
        participantId: text(x.participantId),
        title: text(x.title),
        body: text(x.body),
        final: x.final === true,
      };
    }),
  };
}

export function formatBudget(value?: { used: number; limit: number }, suffix = "") {
  if (!value || value.limit <= 0) return "—";
  return `${value.used} / ${value.limit}${suffix}`;
}

export function SwarmWorkbench({
  runId,
  fetchView,
  checkpointPanel,
  objective,
  runView,
  onOpenParticipant,
}: {
  runView?: UiRunView;
  checkpointPanel?: ReactNode;
  objective?: string;
  runId: string;
  fetchView: (runId: string) => Promise<unknown>;
  onOpenParticipant?: (participantId: string) => void;
}) {
  const [view, setView] = useState<CollaborationView>();
  const [error, setError] = useState<string>();
  const [selectedParticipant, setSelectedParticipant] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    setView(undefined);
    setError(undefined);
    const refresh = () =>
      void fetchView(runId)
        .then((raw) => {
          if (!cancelled) {
            setView(normalizeCollaboration(raw, runId));
            setError(undefined);
          }
        })
        .catch((cause) => {
          if (!cancelled)
            setError(cause instanceof Error ? cause.message : "Agent team data unavailable");
        });
    refresh();
    const timer = runView?.state === "running" ? window.setInterval(refresh, 3000) : undefined;
    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
    };
  }, [fetchView, runId, runView?.state]);
  if (error)
    return (
      <Stack p="xl" align="center" justify="center" mih={240} className="swarm-empty" role="status">
        <Text component="span" size="sm" c="dimmed" className="eyebrow">
          COLLABORATION
        </Text>
        <Title order={1}>Agent team records unavailable</Title>
        <Text size="sm">{error}</Text>
      </Stack>
    );
  if (!view)
    return (
      <Stack p="xl" align="center" justify="center" mih={240} className="swarm-empty">
        <Loader size="sm" className="loader" />
        Loading durable collaboration records…
      </Stack>
    );
  const members = view.participants.map((member) => {
    const invocation =
      runView &&
      asArray(runView.invocations)
        .filter((invocation) =>
          runView.bundle.definitions[
            runView.scopes[invocation.scopeId]?.definitionId ?? runView.bundle.rootDefinitionId
          ]?.nodes.some(
            (node) =>
              node.id === invocation.sourceNodeId &&
              node.kind === "agent" &&
              node.role === member.id,
          ),
        )
        .at(-1);
    const attempt =
      invocation &&
      runView &&
      asArray(runView.attempts)
        .filter((attempt) => attempt.invocationId === invocation.invocationId)
        .at(-1);
    const execution = obj(attempt?.resolvedExecution);
    return {
      ...member,
      role: member.role === "participant" ? member.id : member.role,
      harness:
        member.harness ??
        (isHarness(text(execution.harness)) ? (execution.harness as RuntimeHarness) : undefined),
      model: member.model ?? (text(execution.modelId) || undefined),
    };
  });
  const participant = members.find((item) => item.id === selectedParticipant);
  const isSwarm = runView?.bundle.rootDefinitionId.startsWith("agent-swarm-");
  const peerMessages = view.messages.filter(
    (message) => !message.channelId.startsWith("blackboard"),
  );
  const messages = participant
    ? peerMessages.filter(
        (item) => item.senderId === participant.id || item.recipientIds.includes(participant.id),
      )
    : peerMessages;
  return (
    <Stack gap="xs" component="section" className="swarm-workbench">
      <PageHeader
        actions={
          !isSwarm && (
            <Group gap="sm">
              <Budget label="MESSAGE TURNS" budget={view.budgets.messageTurns} />
              <Budget label="MESSAGES" budget={view.budgets.messages} />
              <Budget label="ELAPSED" budget={view.budgets.elapsedMs} suffix=" ms" />
            </Group>
          )
        }
      >
        {isSwarm ? "Agent swarm" : "Agent team"} · {view.participants.length}{" "}
        {view.participants.length === 1 ? "member" : "members"}
        {!isSwarm && ` · ${view.channels.length} channels`}
      </PageHeader>
      <Stack px="lg" py="md" gap="xs">
        <Text size="xs" c="dimmed">
          SHARED OBJECTIVE
        </Text>
        <Text size="sm" lineClamp={2}>
          {objective ?? view.objective}
        </Text>
        <Disclosure>
          <DisclosureTitle>Full objective & team session</DisclosureTitle>
          <Text size="sm">{objective ?? view.objective}</Text>
          <Text size="xs" c="dimmed">
            Session {view.runId}
          </Text>
        </Disclosure>
        {!view.participants.length && (
          <Alert color="gray">
            This run has no configured agent team. Team members, peer messages and a shared
            blackboard appear here only when a collaboration session is configured. Workflow steps
            and delegated scouts remain in the Workbench.
          </Alert>
        )}
      </Stack>
      <Grid p="lg" gap="lg" className="swarm-grid">
        <Grid.Col span={{ base: 12, lg: 3 }}>
          <Stack gap="lg">
            <Paper className="swarm-panel swarm-participants">
              <Stack gap="md">
                <PanelTitle title="Team members" detail="role · harness · model · state" />
                <Stack gap="xs" className="participant-list">
                  {members.map((item) => (
                    <NavLink
                      component="button"
                      type="button"
                      aria-label={`Select ${item.name}`}
                      key={item.id}
                      active={item.id === selectedParticipant}
                      label={item.name}
                      description={
                        <Stack gap={2}>
                          <Text size="xs" c="dimmed">
                            {item.role} · {item.harness ?? "harness not recorded"}
                          </Text>
                          <Text size="xs" c="dimmed">
                            {item.model ?? "model not recorded"} · {item.activity ?? item.state}
                          </Text>
                        </Stack>
                      }
                      leftSection={<Status state={item.state} />}
                      onClick={() => setSelectedParticipant(item.id)}
                    />
                  ))}
                </Stack>
                {participant && onOpenParticipant && (
                  <Button variant="light" onClick={() => onOpenParticipant(participant.id)}>
                    Open agent activity
                  </Button>
                )}
              </Stack>
            </Paper>
            <Paper className="swarm-panel swarm-blackboard">
              <Stack gap="md">
                <PanelTitle
                  title={isSwarm ? "Artifacts" : "Blackboard & artifacts"}
                  detail={
                    isSwarm
                      ? `${view.artifacts.length} artifacts`
                      : `${view.blackboard.length} typed entries · ${view.artifacts.length} artifacts`
                  }
                />
                {view.blackboard.map((item) => (
                  <Paper component="article" className="board-entry" key={item.id}>
                    <Stack gap="md">
                      <Badge variant="light">{item.type}</Badge>
                      <Text component="span" size="sm" fw={600}>
                        {item.title}
                      </Text>
                      <Text size="sm">{item.body}</Text>
                      <Text component="span" size="xs" c="dimmed">
                        {item.authorId ?? "author not recorded"} · {item.status ?? "active"}
                      </Text>
                    </Stack>
                  </Paper>
                ))}
                {view.artifacts.map((item) => (
                  <Stack gap="xs" className="artifact-row" key={item.id}>
                    <Text component="span" size="sm">
                      <Anchor
                        href={`/api/artifacts/${encodeURIComponent(item.id)}/content`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {item.name}
                      </Anchor>
                      <Text component="span" size="sm" c="dimmed">
                        {item.kind ?? item.contentType ?? "artifact"} ·{" "}
                        {item.producerId ?? "producer not recorded"}
                      </Text>
                    </Text>
                  </Stack>
                ))}
              </Stack>
            </Paper>
          </Stack>
        </Grid.Col>
        <Grid.Col span={{ base: 12, lg: isSwarm ? 9 : 5 }}>
          <Stack gap="md">
            {isSwarm ? (
              <Paper className="swarm-panel" p="md">
                <Stack gap="md">
                  <PanelTitle title="Swarm answers" detail="Contributions and combined answer" />
                  {view.results.length ? (
                    [...view.results]
                      .sort((a, b) => Number(b.final) - Number(a.final))
                      .map((result) => (
                        <Paper key={result.id} p="md" withBorder>
                          <Stack gap="sm">
                            <Text fw={600}>{result.final ? "Final answer" : result.title}</Text>
                            <SafeMarkdown text={result.body} />
                          </Stack>
                        </Paper>
                      ))
                  ) : (
                    <Text size="sm" c="dimmed">
                      {runView &&
                      ["failed", "cancelled", "interrupted", "recovery-required"].includes(
                        runView.state,
                      )
                        ? `No answers completed before the swarm ${runView.state}.`
                        : "The selected models are working on your task. Their answers will appear here."}
                    </Text>
                  )}
                </Stack>
              </Paper>
            ) : (
              <Paper className="swarm-panel swarm-messages">
                <Stack gap="md">
                  <PanelTitle
                    title="Direct message stream"
                    detail={participant ? participant.name : "all teammates"}
                  />
                  <ScrollArea.Autosize mah={480}>
                    <Stack gap="md" className="message-stream">
                      {messages.length ? (
                        messages.map((item) => (
                          <Paper component="article" className="swarm-message" key={item.id}>
                            <Stack gap="md">
                              <Group
                                gap="xs"
                                justify="space-between"
                                wrap="wrap"
                                className="message-meta"
                              >
                                <Text component="span" size="sm" fw={600}>
                                  {view.participants.find((member) => member.id === item.senderId)
                                    ?.name ?? item.senderId}
                                </Text>
                                <Text component="span" size="sm">
                                  {item.type ?? "message"} ·{" "}
                                  {item.createdAt
                                    ? new Date(item.createdAt).toLocaleTimeString([], {
                                        hour: "2-digit",
                                        minute: "2-digit",
                                      })
                                    : "time not recorded"}
                                </Text>
                              </Group>
                              <Text size="sm">{item.body}</Text>
                              <Group
                                gap="xs"
                                justify="space-between"
                                wrap="wrap"
                                className="message-links"
                              >
                                to {item.recipientIds.join(", ") || "channel"}
                                {item.senderAttemptId && (
                                  <>
                                    {" "}
                                    · sender attempt <Code>{item.senderAttemptId}</Code>
                                  </>
                                )}
                                {item.recipientContextIds?.length ? (
                                  <> · context {item.recipientContextIds.join(", ")}</>
                                ) : null}
                              </Group>
                            </Stack>
                          </Paper>
                        ))
                      ) : (
                        <Stack gap="xs" className="empty-inline">
                          No messages recorded for this participant.
                        </Stack>
                      )}
                    </Stack>
                  </ScrollArea.Autosize>
                </Stack>
              </Paper>
            )}
            <Paper className="swarm-panel swarm-timeline">
              <Stack gap="md">
                <PanelTitle
                  title="Participant timeline"
                  detail={participant ? participant.name : "all participants"}
                />
                <Stack gap="xs" className="timeline-events">
                  {view.timeline
                    .filter((event) => !participant || event.participantId === participant.id)
                    .map((event) => (
                      <Stack gap="xs" className="timeline-event" key={event.id}>
                        <Status state={event.type} />
                        <Stack gap={0}>
                          <Text size="sm" fw={600}>
                            {event.label}
                          </Text>
                          <Text size="sm" c="dimmed">
                            {event.participantId} · {event.at}
                          </Text>
                        </Stack>
                      </Stack>
                    ))}
                </Stack>
              </Stack>
            </Paper>
          </Stack>
        </Grid.Col>
        {!isSwarm && <Grid.Col span={{ base: 12, lg: 4 }}>{checkpointPanel}</Grid.Col>}
      </Grid>
    </Stack>
  );
}
function PanelTitle({ title, detail }: { title: string; detail: string }) {
  return (
    <Group gap="sm" justify="space-between" mb="md" className="swarm-panel-heading">
      <Text component="span" size="sm" fw={600}>
        {title}
      </Text>
      <Text component="span" size="sm">
        {detail}
      </Text>
    </Group>
  );
}
function Budget({
  label,
  budget,
  suffix = "",
}: {
  label: string;
  budget?: { used: number; limit: number };
  suffix?: string;
}) {
  return (
    <Paper p="xs" miw={130}>
      <Stack gap={6}>
        <Text size="xs" c="dimmed">
          {label}
        </Text>
        <Text size="sm" fw={600}>
          {formatBudget(budget, suffix)}
        </Text>
        {budget && budget.limit > 0 && (
          <Progress
            size="xs"
            value={Math.min(100, (budget.used / budget.limit) * 100)}
            color={budget.used >= budget.limit ? "yellow" : "indigo"}
          />
        )}
      </Stack>
    </Paper>
  );
}
function Status({ state }: { state: string }) {
  return (
    <ThemeIcon
      size={10}
      radius="xl"
      variant="filled"
      color={stateColor(state)}
      className={`swarm-status swarm-${state}`}
      aria-label={state}
    />
  );
}
