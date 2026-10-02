import { useEffect, useState } from "react";
import { Alert, Badge, Button, Group, Paper, Stack, Text, Title } from "@mantine/core";

interface Progress {
  phase: string;
  maxConcurrent?: number;
  error?: string;
  milestones: Array<{
    id: string;
    title: string;
    task: string;
    workflowId: string;
    workflowVersion?: string;
    workflowName?: string;
    dependsOn: string[];
    status: string;
    scopeId: string;
    invocationIds: string[];
  }>;
}
export function MilestonesPanel({
  runId,
  revision,
  api,
  onOpen,
}: {
  runId: string;
  revision: number;
  api: <T>(path: string) => Promise<T>;
  onOpen: (scopeId: string, approval: boolean) => void;
}) {
  const [progress, setProgress] = useState<Progress>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    api<Progress>(`/api/runs/${encodeURIComponent(runId)}/milestones`)
      .then((value) => {
        if (active) {
          setProgress(value);
          setError(undefined);
        }
      })
      .catch((cause) => {
        if (active) setError(String(cause));
      });
    return () => {
      active = false;
    };
  }, [runId, revision, api]);
  return (
    <Stack p="lg">
      <Group>
        <Title order={2}>Milestones</Title>
        <Badge>{progress?.phase ?? "Loading"}</Badge>
      </Group>
      {(error || progress?.error) && <Alert color="red">{error ?? progress?.error}</Alert>}
      {progress?.phase === "planning" && (
        <Text>The planner is generating milestones and choosing from the available workflows.</Text>
      )}
      {!!progress?.maxConcurrent && (
        <Text c="dimmed">
          Up to {progress.maxConcurrent} milestones run in parallel. Dependents wait for successful
          prerequisites.
        </Text>
      )}
      {progress?.milestones.map((item) => (
        <Paper key={item.id} withBorder p="md">
          <Stack gap="xs">
            <Group justify="space-between">
              <Text fw={600}>{item.title}</Text>
              <Badge
                color={
                  item.status === "succeeded"
                    ? "green"
                    : ["failed", "blocked"].includes(item.status)
                      ? "red"
                      : item.status === "approval"
                        ? "yellow"
                        : "blue"
                }
              >
                {item.status === "approval" ? "Waiting for approval" : item.status}
              </Badge>
            </Group>
            <Text size="sm" c="dimmed">
              {item.id} · {item.workflowName ?? item.workflowId}
              {item.workflowVersion ? ` v${item.workflowVersion}` : ""} ·{" "}
              {item.dependsOn.length ? `After: ${item.dependsOn.join(", ")}` : "No prerequisites"}
            </Text>
            <Text size="sm">{item.task}</Text>
            {item.invocationIds.length > 0 && (
              <Button
                variant="light"
                size="xs"
                onClick={() => onOpen(item.scopeId, item.status === "approval")}
              >
                {item.status === "approval" ? "Review approval" : "Open milestone session"}
              </Button>
            )}
            {item.status === "blocked" && (
              <Text size="sm" c="red">
                A prerequisite failed; this milestone will not start.
              </Text>
            )}
          </Stack>
        </Paper>
      ))}
    </Stack>
  );
}
