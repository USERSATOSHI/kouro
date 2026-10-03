import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Fieldset,
  Group,
  NativeSelect,
  NumberInput,
  Paper,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import type { Harness } from "@kouro/core";

export interface TaskLaunchRequest {
  task: string;
  workflowIds: string[];
  planner: { harness: Harness; modelId: string };
  executor: { harness: Harness; modelId: string };
  maxMilestones: number;
  maxConcurrent: number;
  idempotencyKey: string;
  workspace?: { repositoryPath: string };
}
interface Choice {
  id: string;
  name: string;
  version: string;
  eligible: boolean;
  reason?: string;
  requiresWorkspace: boolean;
  approvalGates: number;
}
export function TaskLauncher({
  api,
  onLaunch,
  launching,
}: {
  api: <T>(path: string) => Promise<T>;
  onLaunch: (request: TaskLaunchRequest) => Promise<boolean>;
  launching: boolean;
}) {
  const [choices, setChoices] = useState<Choice[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [loaded, setLoaded] = useState(false);
  const [task, setTask] = useState("");
  const [repository, setRepository] = useState("");
  const [harness, setHarness] = useState<Harness>("codex");
  const [model, setModel] = useState("");
  const [executorHarness, setExecutorHarness] = useState<Harness>("codex");
  const [executorModel, setExecutorModel] = useState("");
  const [maxMilestones, setMaxMilestones] = useState(3);
  const [maxConcurrent, setMaxConcurrent] = useState(2);
  const request = useRef<{ identity: string; key: string } | undefined>(undefined);
  const submitting = useRef(false);
  useEffect(() => {
    let active = true;
    api<Choice[]>("/api/task-workflows")
      .then((items) => {
        if (!active) return;
        setChoices(items);
        setSelected(items.filter((item) => item.eligible).map((item) => item.id));
        setLoaded(true);
      })
      .catch((cause) => {
        if (active) setError(String(cause));
      });
    return () => {
      active = false;
    };
  }, [api]);
  const needsRepository = choices.some(
    (item) => selected.includes(item.id) && item.requiresWorkspace,
  );
  const ready =
    loaded &&
    selected.length > 0 &&
    task.trim() &&
    model.trim() &&
    executorModel.trim() &&
    (!needsRepository || repository.trim());
  const harnesses = [
    { value: "codex", label: "Codex" },
    { value: "pi", label: "Pi" },
    { value: "claude", label: "Claude" },
    { value: "opencode", label: "OpenCode" },
  ];
  return (
    <Paper
      p="lg"
      m="lg"
      withBorder
      component="form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!ready || launching || submitting.current) return;
        submitting.current = true;
        const values = {
          task: task.trim(),
          workflowIds: selected,
          planner: { harness, modelId: model.trim() },
          executor: { harness: executorHarness, modelId: executorModel.trim() },
          maxMilestones,
          maxConcurrent,
          ...(repository.trim() ? { workspace: { repositoryPath: repository.trim() } } : {}),
        };
        const identity = JSON.stringify(values);
        if (request.current?.identity !== identity)
          request.current = { identity, key: crypto.randomUUID() };
        try {
          if (await onLaunch({ ...values, idempotencyKey: request.current.key }))
            request.current = undefined;
        } finally {
          submitting.current = false;
        }
      }}
    >
      <Stack gap="lg">
        <Title order={1}>Workflow task</Title>
        <Text c="dimmed">
          Give Kouro one task. It will generate milestones, choose workflows, and run independent
          work in parallel. Workflow approval gates pause for your decision.
        </Text>
        {error && <Alert color="red">{error}</Alert>}
        <Fieldset legend="Available workflows" disabled={launching}>
          <Stack>
            {!loaded && !error && <Text>Loading workflows…</Text>}
            {choices.map((item) => (
              <Checkbox
                key={item.id}
                label={`${item.name} · v${item.version}`}
                disabled={!item.eligible}
                description={
                  item.reason ??
                  `${item.approvalGates} approval gates${item.requiresWorkspace ? " · needs a repository" : ""}`
                }
                checked={selected.includes(item.id)}
                onChange={(event) =>
                  setSelected(
                    event.currentTarget.checked
                      ? [...selected, item.id]
                      : selected.filter((id) => id !== item.id),
                  )
                }
              />
            ))}
          </Stack>
        </Fieldset>
        <Fieldset legend="Models" disabled={launching}>
          <Stack>
            <Group grow>
              <NativeSelect
                label="Planning harness"
                data={harnesses}
                value={harness}
                onChange={(event) => setHarness(event.currentTarget.value as Harness)}
              />
              <TextInput
                label="Planning model"
                placeholder="Model ID"
                required
                maxLength={200}
                value={model}
                onChange={(event) => setModel(event.currentTarget.value)}
              />
            </Group>
            <Group grow>
              <NativeSelect
                label="Execution harness"
                data={harnesses}
                value={executorHarness}
                onChange={(event) => setExecutorHarness(event.currentTarget.value as Harness)}
              />
              <TextInput
                label="Execution model"
                placeholder="Model ID"
                required
                maxLength={200}
                value={executorModel}
                onChange={(event) => setExecutorModel(event.currentTarget.value)}
              />
            </Group>
            <Text size="sm" c="dimmed">
              The execution model fills agents whose workflow does not already choose a model.
            </Text>
          </Stack>
        </Fieldset>
        <Textarea
          label="Task"
          value={task}
          onChange={(event) => setTask(event.currentTarget.value)}
          required
          autosize
          minRows={4}
          maxLength={20000}
          disabled={launching}
        />
        <TextInput
          label="Repository path"
          placeholder="/path/to/a git repository"
          required={needsRepository}
          value={repository}
          onChange={(event) => setRepository(event.currentTarget.value)}
          disabled={launching}
          description="Milestones use isolated worktrees. Completed prerequisites feed dependent milestones; the result appears in Delivery."
        />
        <Group grow>
          <NumberInput
            label="Maximum milestones"
            value={maxMilestones}
            min={1}
            max={12}
            allowDecimal={false}
            disabled={launching}
            onChange={(value) => {
              const max = Number(value) || 1;
              setMaxMilestones(max);
              setMaxConcurrent((current) => Math.min(current, max));
            }}
          />
          <NumberInput
            label="Parallel milestones"
            value={maxConcurrent}
            min={1}
            max={maxMilestones}
            allowDecimal={false}
            disabled={launching}
            onChange={(value) => setMaxConcurrent(Number(value) || 1)}
          />
        </Group>
        <Button type="submit" loading={launching} disabled={!ready}>
          Start workflow task
        </Button>
      </Stack>
    </Paper>
  );
}
