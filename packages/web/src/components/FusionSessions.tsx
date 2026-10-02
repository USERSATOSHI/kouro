import {
  Accordion,
  Alert,
  Badge,
  Group,
  NativeSelect,
  Paper,
  SimpleGrid,
  Stack,
  Text,
} from "@mantine/core";
import { useEffect, useState } from "react";
import type { AgentNode } from "@kouro/core";
import { asArray, type UiRunView } from "../types";
import { AgentSessionModal, SafeMarkdown, type ActivityPage } from "./AgentSession";

type ControlAction = (
  action: string,
  invocationId?: string,
  message?: string,
  attemptId?: string,
) => Promise<boolean>;
type SessionProps = {
  view: UiRunView;
  onControl: ControlAction;
  pendingAction?: string;
  loadActivity: (runId: string, attemptId: string, after: number) => Promise<ActivityPage>;
};

export function fusionGroups(view: UiRunView) {
  return Object.entries(view.bundle.definitions).flatMap(([definitionId, definition]) => {
    const groups = [
      ...new Set(
        definition.nodes.flatMap((node) =>
          node.kind === "agent" && node.fusion ? [node.fusion.groupId] : [],
        ),
      ),
    ].filter(
      (id) =>
        definition.nodes.filter(
          (node) =>
            node.kind === "agent" && node.fusion?.groupId === id && node.fusion.stage === "draft",
        ).length >= 2,
    );
    return asArray(view.scopes)
      .filter((scope) => scope.definitionId === definitionId)
      .flatMap((scope) =>
        groups.map((groupId) => ({
          key: `${scope.id}:${groupId}`,
          scopeId: scope.id,
          definitionId,
          groupId,
        })),
      );
  });
}

export function FusionSessions(props: SessionProps) {
  const { view } = props;
  const groups = fusionGroups(view);
  const [selectedGroup, setGroup] = useState(groups[0]?.key ?? "");
  const group = groups.find((item) => item.key === selectedGroup) ?? groups[0];
  const nodes = (view.bundle.definitions[group?.definitionId ?? ""]?.nodes ?? []).filter(
    (node): node is AgentNode => node.kind === "agent" && node.fusion?.groupId === group?.groupId,
  );
  const members = nodes.filter((node) => node.fusion?.stage === "draft");
  const [stage, setStage] = useState("live");
  const [left, setLeft] = useState(members[0]?.id ?? "");
  const [right, setRight] = useState(members[1]?.id ?? "");
  const rounds = Math.max(0, ...nodes.map((node) => node.fusion!.round));
  const invocations = asArray(view.invocations).filter(
    (invocation) =>
      invocation.scopeId === group?.scopeId &&
      nodes.some((node) => node.id === invocation.sourceNodeId),
  );
  const activeStages = nodes.filter(
    (node) =>
      node.fusion?.stage !== "synthesis" &&
      invocations.some((invocation) => invocation.sourceNodeId === node.id),
  );
  const latest = activeStages.reduce(
    (value, node) =>
      Math.max(value, node.fusion!.round * 2 - (node.fusion!.stage === "review" ? 1 : 0)),
    0,
  );
  const currentStage = stage === "live" ? latest : Number(stage);
  const label = (value: number) =>
    value === 0
      ? "Initial drafts"
      : `${value % 2 ? "Review" : "Revision"} round ${Math.ceil(value / 2)}`;
  const memberOptions = members.map((node) => ({ value: node.id, label: node.modelId ?? node.id }));
  const leftMember = members.find((node) => node.id === left) ?? members[0];
  const rightMember =
    members.find((node) => node.id === right && node.id !== leftMember?.id) ??
    members.find((node) => node.id !== leftMember?.id);
  const stageNode = (member?: AgentNode) =>
    nodes.find(
      (node) =>
        node.fusion!.memberId === member?.id &&
        node.fusion!.round === Math.ceil(currentStage / 2) &&
        node.fusion!.stage ===
          (currentStage === 0 ? "draft" : currentStage % 2 ? "review" : "revision"),
    );
  const synthesis = nodes.find((node) => node.fusion?.stage === "synthesis");
  const synthesisInvocation = invocations
    .filter((item) => item.sourceNodeId === synthesis?.id)
    .at(-1);
  const artifactId =
    synthesisInvocation?.state === "succeeded"
      ? synthesisInvocation.outputArtifactIds[0]
      : undefined;
  const [plan, setPlan] = useState<{ artifactId: string; text?: string; error?: string }>();
  useEffect(() => {
    if (!artifactId) return;
    let cancelled = false;
    void fetch(`/api/artifacts/${encodeURIComponent(artifactId)}/content`, {
      credentials: "same-origin",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Combined plan is unavailable");
        const content = await response.text();
        let text = content;
        try {
          const report = JSON.parse(content);
          if (typeof report.summary === "string") text = report.summary;
        } catch {
          /* Plain text artifacts are also supported. */
        }
        if (!cancelled) setPlan({ artifactId, text });
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setPlan({
            artifactId,
            error: error instanceof Error ? error.message : "Combined plan is unavailable",
          });
      });
    return () => {
      cancelled = true;
    };
  }, [artifactId]);
  return (
    <Stack data-testid="fusion-sessions">
      <Group align="end">
        {groups.length > 1 && (
          <NativeSelect
            label="Fusion group"
            value={group?.key}
            data={groups.map((item) => ({
              value: item.key,
              label: `${item.groupId} · ${item.scopeId}`,
            }))}
            onChange={(event) => setGroup(event.currentTarget.value)}
          />
        )}
        <NativeSelect
          label="Planning stage"
          value={stage}
          onChange={(event) => setStage(event.currentTarget.value)}
          data={[
            { value: "live", label: `Follow latest · ${label(latest)}` },
            ...Array.from({ length: rounds * 2 + 1 }, (_, value) => ({
              value: String(value),
              label: label(value),
            })),
          ]}
        />
        <Badge variant="light">{label(currentStage)}</Badge>
        <Text size="sm" c="dimmed">
          {rounds} review rounds
        </Text>
      </Group>
      {members.length > 2 && (
        <SimpleGrid cols={2}>
          <NativeSelect
            label="Left model"
            value={leftMember?.id}
            data={memberOptions}
            onChange={(event) => setLeft(event.currentTarget.value)}
          />
          <NativeSelect
            label="Right model"
            value={rightMember?.id}
            data={memberOptions.filter((option) => option.value !== leftMember?.id)}
            onChange={(event) => setRight(event.currentTarget.value)}
          />
        </SimpleGrid>
      )}
      <SimpleGrid cols={{ base: 1, lg: 2 }} style={{ alignItems: "start" }}>
        {[leftMember, rightMember].map((member, index) => (
          <Paper
            key={member?.id ?? index}
            withBorder
            p="sm"
            miw={0}
            data-testid={`fusion-session-${index + 1}`}
          >
            <Text fw={600} mb="sm">
              {member?.id}
            </Text>
            <FusionSessionLane {...props} scopeId={group?.scopeId} node={stageNode(member)} />
          </Paper>
        ))}
      </SimpleGrid>
      <Paper withBorder p="md" data-testid="fusion-combined-plan">
        <Stack>
          <Text fw={600}>Combined plan</Text>
          {plan && plan.artifactId === artifactId && plan.error ? (
            <Alert color="red">{plan.error}</Alert>
          ) : plan && plan.artifactId === artifactId && plan.text ? (
            <SafeMarkdown text={plan.text} />
          ) : (
            <Text c="dimmed">
              {synthesisInvocation
                ? `Synthesis ${synthesisInvocation.state}`
                : "Waiting for the planning rounds to finish"}
            </Text>
          )}
          {synthesisInvocation && (
            <Accordion>
              <Accordion.Item value="synthesis">
                <Accordion.Control>Synthesis activity</Accordion.Control>
                <Accordion.Panel>
                  <FusionSessionLane {...props} scopeId={group?.scopeId} node={synthesis} />
                </Accordion.Panel>
              </Accordion.Item>
            </Accordion>
          )}
        </Stack>
      </Paper>
    </Stack>
  );
}

function FusionSessionLane({
  node,
  scopeId,
  view,
  onControl,
  pendingAction,
  loadActivity,
}: SessionProps & { node?: AgentNode; scopeId?: string }) {
  const invocation = asArray(view.invocations)
    .filter((item) => item.sourceNodeId === node?.id && item.scopeId === scopeId)
    .at(-1);
  const attempt = asArray(view.attempts)
    .filter((item) => item.invocationId === invocation?.invocationId)
    .at(-1);
  const execution =
    attempt?.resolvedExecution && typeof attempt.resolvedExecution === "object"
      ? (attempt.resolvedExecution as Record<string, unknown>)
      : {};
  const identity = `${String(execution.harness ?? node?.harness ?? "Default harness")} · ${String(execution.modelId ?? node?.modelId ?? "Default model")}`;
  if (!attempt || !invocation)
    return (
      <Stack>
        <Text size="sm">{identity}</Text>
        <Text c="dimmed">Waiting for this stage</Text>
      </Stack>
    );
  return (
    <AgentSessionModal
      embedded
      key={`${view.runId}:${attempt.attemptId}`}
      runId={view.runId}
      invocationId={invocation.invocationId}
      attemptId={attempt.attemptId}
      nodeId={node!.id}
      harness={identity}
      initialSpeaker="all"
      events={(view.liveActivity ?? []).filter((item) => item.attemptId === attempt.attemptId)}
      live={attempt.state === "running"}
      steerable={
        attempt.state === "running" &&
        invocation.state === "running" &&
        Boolean(view.capabilities.steer) &&
        (view.steerableInvocationIds?.includes(invocation.invocationId) ?? true)
      }
      canStop={Boolean(view.capabilities.cancel)}
      stopPending={pendingAction === "cancel"}
      onStop={() => void onControl("cancel")}
      canInterrupt={
        attempt.state === "running" &&
        Boolean(view.interruptibleInvocationIds?.includes(invocation.invocationId))
      }
      interruptPending={pendingAction === "interrupt-attempt"}
      onInterrupt={() =>
        void onControl("interrupt-attempt", invocation.invocationId, undefined, attempt.attemptId)
      }
      onSteer={(message) => onControl("steer", invocation.invocationId, message, attempt.attemptId)}
      loadActivity={loadActivity}
      onClose={() => {}}
    />
  );
}
