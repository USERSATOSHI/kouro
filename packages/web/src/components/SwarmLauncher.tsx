import { useRef, useState } from "react";
import {
  Button,
  Fieldset,
  Group,
  NativeSelect,
  Paper,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import type { Harness } from "@kouro/core";

export interface SwarmLaunchRequest {
  models: Array<{ harness: Harness; modelId: string }>;
  task: string;
  idempotencyKey: string;
  workspace?: { repositoryPath: string };
}

export function SwarmLauncher({
  onLaunch,
  launching,
}: {
  onLaunch: (request: SwarmLaunchRequest) => Promise<boolean>;
  launching: boolean;
}) {
  const [models, setModels] = useState<SwarmLaunchRequest["models"]>([
    { harness: "codex", modelId: "" },
  ]);
  const [task, setTask] = useState("");
  const [workspace, setWorkspace] = useState("");
  const request = useRef<{ identity: string; key: string } | undefined>(undefined);
  const submitting = useRef(false);
  const modelsReady = models.every((model) => model.modelId.trim());
  return (
    <Paper
      p="lg"
      m="lg"
      withBorder
      component="form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (submitting.current || launching || !modelsReady || !task.trim()) return;
        submitting.current = true;
        const values = {
          models: models.map((model) => ({ ...model, modelId: model.modelId.trim() })),
          task: task.trim(),
          ...(workspace.trim() ? { workspace: { repositoryPath: workspace.trim() } } : {}),
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
        <Title order={1}>Agent swarm</Title>
        <Text c="dimmed">Choose the models in your swarm, then give them a shared task.</Text>
        <Fieldset legend="1. Choose models" disabled={launching}>
          <Stack>
            {models.map((model, index) => (
              <Group key={index} align="end" wrap="wrap">
                <NativeSelect
                  label={`Harness ${index + 1}`}
                  value={model.harness}
                  data={[
                    { value: "codex", label: "Codex" },
                    { value: "pi", label: "Pi" },
                    { value: "claude", label: "Claude" },
                    { value: "opencode", label: "OpenCode" },
                  ]}
                  onChange={(event) => {
                    const harness = event.currentTarget.value as Harness;
                    setModels(models.map((item, i) => (i === index ? { ...item, harness } : item)));
                  }}
                />
                <TextInput
                  style={{ flex: 1, minWidth: 180 }}
                  label={`Model ${index + 1}`}
                  value={model.modelId}
                  maxLength={200}
                  placeholder="Model ID"
                  required
                  onChange={(event) => {
                    const modelId = event.currentTarget.value;
                    setModels(models.map((item, i) => (i === index ? { ...item, modelId } : item)));
                  }}
                />
                <Button
                  variant="subtle"
                  disabled={models.length === 1}
                  aria-label={`Remove model ${index + 1}`}
                  onClick={() => setModels(models.filter((_, i) => i !== index))}
                >
                  Remove
                </Button>
              </Group>
            ))}
            <Button
              variant="light"
              disabled={models.length >= 8}
              onClick={() =>
                setModels([...models, { harness: models.at(-1)!.harness, modelId: "" }])
              }
            >
              Add model
            </Button>
            <Text size="sm" c="dimmed">
              Each model works on the task. The first model combines their answers.
            </Text>
          </Stack>
        </Fieldset>
        <Fieldset legend="2. Give the swarm a task" disabled={!modelsReady || launching}>
          <Stack>
            <Textarea
              label="Swarm task"
              value={task}
              required
              autosize
              minRows={4}
              placeholder="What should this swarm work on?"
              onChange={(event) => setTask(event.currentTarget.value)}
            />
            <TextInput
              label="Repository path"
              value={workspace}
              placeholder="/path/to/a git repository"
              description="Optional repository context for the task."
              onChange={(event) => setWorkspace(event.currentTarget.value)}
            />
          </Stack>
        </Fieldset>
        <Button
          type="submit"
          loading={launching}
          disabled={!modelsReady || !task.trim()}
          data-testid="start-swarm"
        >
          Start swarm
        </Button>
      </Stack>
    </Paper>
  );
}
