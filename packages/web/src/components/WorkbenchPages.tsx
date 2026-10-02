import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Code,
  Grid,
  Group,
  NativeSelect,
  Paper,
  SegmentedControl,
  Slider,
  Stack,
  Table,
  Text,
  TextInput,
  useMantineColorScheme,
} from "@mantine/core";
import { IconArrowRight, IconTrash } from "@tabler/icons-react";
import { useEffect, useState, type ReactNode } from "react";
import type { RunSummary, WorkflowSummary } from "../types";
import { stateColor } from "../theme";
import { PageHeader, WorkbenchPanel } from "./WorkbenchPrimitives";

export function RunsDashboard({
  runs,
  onOpen,
  onNew,
  onDelete,
  onOlder,
  hasMore,
  loadingOlder,
  selectedRunId,
}: {
  runs: RunSummary[];
  workflows: WorkflowSummary[];
  onOpen: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onOlder: () => void;
  hasMore: boolean;
  loadingOlder: boolean;
  approvals: number;
  selectedRunId?: string;
}) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [selected, setSelected] = useState(selectedRunId);
  const filtered = runs.filter(
    (run) =>
      (status === "all" || run.state === status) &&
      `${run.id} ${run.task ?? ""} ${run.workflowId}`.toLowerCase().includes(search.toLowerCase()),
  );
  const detail = runs.find((run) => run.id === selected);
  return (
    <Stack gap={0}>
      <PageHeader
        actions={
          <Group>
            <TextInput
              aria-label="Search runs"
              placeholder="Filter by task or ID"
              value={search}
              onChange={(event) => setSearch(event.currentTarget.value)}
              w={{ base: 180, md: 330 }}
            />
            <NativeSelect
              aria-label="Filter runs by state"
              value={status}
              onChange={(event) => setStatus(event.currentTarget.value)}
              data={["all", ...new Set(runs.map((run) => run.state))].map((value) => ({
                value,
                label: value === "all" ? "All states" : value,
              }))}
            />
            <Button variant="filled" onClick={onNew}>
              New run
            </Button>
          </Group>
        }
      >
        Runs
      </PageHeader>
      <Stack p="lg" gap="lg">
        <Paper p={0} bg="var(--mantine-color-default)">
          <Table.ScrollContainer minWidth={1000}>
            <Table verticalSpacing="sm">
              <Table.Thead>
                <Table.Tr>
                  {["Task", "Workflow", "State", "Started", "Elapsed", "ID", ""].map((label) => (
                    <Table.Th key={label}>
                      <Text size="xs" fw={400} c="dimmed" tt="uppercase">
                        {label}
                      </Text>
                    </Table.Th>
                  ))}
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {filtered.map((run) => (
                  <Table.Tr
                    key={run.id}
                    onClick={() => setSelected(run.id)}
                    bg={selected === run.id ? "var(--mantine-primary-color-light)" : undefined}
                  >
                    <Table.Td>
                      <Text size="sm" maw={450} truncate title={run.task ?? run.workflowId}>
                        {run.task || run.workflowId}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{run.workflowId}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" ff="monospace" c={stateColor(run.state)}>
                        {run.state.replaceAll("-", " ")}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" ff="monospace" c="dimmed">
                        {run.startedAt
                          ? new Date(run.startedAt).toLocaleString()
                          : run.createdAt
                            ? new Date(run.createdAt).toLocaleString()
                            : "unavailable"}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" ff="monospace">
                        {elapsed(run)}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Code>{run.id.slice(0, 16)}</Code>
                    </Table.Td>
                    <Table.Td>
                      <Group gap="xs" wrap="nowrap">
                        <ActionIcon
                          aria-label={`Open run ${run.id}`}
                          variant="subtle"
                          onClick={() => onOpen(run.id)}
                        >
                          <IconArrowRight size={16} />
                        </ActionIcon>
                        <ActionIcon
                          aria-label={`Delete run ${run.id.slice(0, 12)}`}
                          color="red"
                          variant="subtle"
                          onClick={(event) => {
                            event.stopPropagation();
                            onDelete(run.id);
                          }}
                        >
                          <IconTrash size={14} />
                        </ActionIcon>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
          {!filtered.length && (
            <Text size="sm" c="dimmed" p="md">
              {runs.length ? "No matching runs." : "No runs yet. Choose a workflow to start."}
            </Text>
          )}
          {hasMore && (
            <Button m="md" onClick={onOlder} loading={loadingOlder}>
              Load older runs
            </Button>
          )}
        </Paper>
        {detail && (
          <WorkbenchPanel label="Run header · expanded details">
            <Text size="sm">Task (full text): {detail.task || detail.workflowId}</Text>
            <Text size="xs" c="dimmed" ff="monospace">
              workflow {detail.workflowId} · run {detail.id} · {detail.state} · revision{" "}
              {detail.revision ?? "unavailable"}
            </Text>
            <Button w="fit-content" onClick={() => onOpen(detail.id)}>
              Open workbench
            </Button>
          </WorkbenchPanel>
        )}
        <Text size="xs" c="dimmed">
          Filtering covers loaded runs.
        </Text>
      </Stack>
    </Stack>
  );
}
function elapsed(run: RunSummary) {
  if (!run.startedAt) return "unavailable";
  const end = run.endedAt ? Date.parse(run.endedAt) : Date.now();
  const seconds = Math.max(0, Math.round((end - Date.parse(run.startedAt)) / 1000));
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export type QueueItem = {
  runId: string;
  workflowId: string;
  task?: string;
  invocationId: string;
  approvalId?: string;
  action: string;
};
export function ApprovalQueue({
  items,
  onOpen,
  onSelect,
  renderDetail,
}: {
  items: QueueItem[];
  onOpen: (item: QueueItem) => void;
  onSelect: (item: QueueItem) => void;
  renderDetail: (item: QueueItem) => ReactNode;
}) {
  const [selected, setSelected] = useState<string>();
  const item = items.find((item) => `${item.runId}:${item.invocationId}` === selected) ?? items[0];
  useEffect(() => {
    if (item) onSelect(item);
  }, [item?.runId, item?.invocationId]);
  return (
    <Stack gap={0}>
      <PageHeader>
        Approvals{" "}
        <Text component="span" fw={600}>
          {items.length}
        </Text>
      </PageHeader>
      <Grid p="lg" gap="lg">
        <Grid.Col span={{ base: 12, lg: 4 }}>
          <Paper p={0} mih={350}>
            {items.length ? (
              items.map((candidate) => (
                <Button
                  key={candidate.approvalId ?? `${candidate.runId}:${candidate.invocationId}`}
                  fullWidth
                  h="auto"
                  py="md"
                  px="md"
                  justify="start"
                  variant={candidate === item ? "light" : "subtle"}
                  onClick={() => setSelected(`${candidate.runId}:${candidate.invocationId}`)}
                >
                  <Stack gap={5} align="start">
                    <Text size="sm">
                      {candidate.action || candidate.task || candidate.workflowId}
                    </Text>
                    <Text size="xs" c="dimmed" ff="monospace">
                      pending · run {candidate.runId.slice(0, 12)}
                    </Text>
                  </Stack>
                </Button>
              ))
            ) : (
              <Text p="md" c="dimmed" size="sm">
                No pending approvals.
              </Text>
            )}
          </Paper>
        </Grid.Col>
        <Grid.Col span={{ base: 12, lg: 8 }}>
          {item ? (
            <WorkbenchPanel label="Proposal">
              <Text size="sm">{item.task || item.action || item.workflowId}</Text>
              <Text size="xs" c="dimmed">
                {item.workflowId} · invocation {item.invocationId}
              </Text>
              {renderDetail(item)}
              <Button w="fit-content" onClick={() => onOpen(item)}>
                Open reviewed patch
              </Button>
            </WorkbenchPanel>
          ) : (
            <Paper>
              <Text size="sm" c="dimmed">
                Select a pending approval to view its evidence and repair budget.
              </Text>
            </Paper>
          )}
        </Grid.Col>
      </Grid>
    </Stack>
  );
}

export function WorkbenchSettings({
  sidebarWidth,
  setSidebarWidth,
  inspectorWidth,
  setInspectorWidth,
  status,
  error,
  onReconnect,
  onOpenSession,
}: {
  sidebarWidth: number;
  setSidebarWidth: (value: number) => void;
  inspectorWidth: number;
  setInspectorWidth: (value: number) => void;
  status: string;
  error?: string;
  onReconnect: () => void;
  onOpenSession: () => void;
}) {
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const [mode, setMode] = useState(() => {
    try {
      return localStorage.getItem("kouro.view.mode") ?? "split";
    } catch {
      return "split";
    }
  });
  return (
    <Stack gap={0}>
      <PageHeader>Settings</PageHeader>
      <Grid p="lg" gap="lg">
        <Grid.Col span={{ base: 12, lg: 6 }}>
          <Stack gap="lg">
            <WorkbenchPanel label="Saved layout">
              <Text size="sm">Sidebar width · {sidebarWidth}px</Text>
              <Slider
                aria-label="Navigation width"
                min={200}
                max={360}
                value={sidebarWidth}
                onChange={setSidebarWidth}
              />
              <Text size="sm">Inspector width · {inspectorWidth}px</Text>
              <Slider
                aria-label="Inspector width"
                min={280}
                max={560}
                value={inspectorWidth}
                onChange={setInspectorWidth}
              />
              <Text size="xs" c="dimmed" ff="monospace">
                View mode · saved in this browser
              </Text>
              <SegmentedControl
                aria-label="Default workbench view"
                value={mode}
                onChange={(value) => {
                  setMode(value);
                  try {
                    localStorage.setItem("kouro.view.mode", value);
                  } catch {
                    /* Preferences remain usable without storage. */
                  }
                }}
                data={[
                  { value: "split", label: "Split" },
                  { value: "graph", label: "Graph" },
                  { value: "timeline", label: "Timeline" },
                ]}
              />
              <Button
                w="fit-content"
                onClick={() => {
                  setSidebarWidth(258);
                  setInspectorWidth(420);
                }}
              >
                Reset widths
              </Button>
            </WorkbenchPanel>
            <WorkbenchPanel label="Focus and motion">
              <Button w="fit-content">Focus preview</Button>
              <Text size="sm">
                Escape closes session dialogs and returns focus to the opener. Motion follows your
                system reduced-motion preference.
              </Text>
            </WorkbenchPanel>
          </Stack>
        </Grid.Col>
        <Grid.Col span={{ base: 12, lg: 6 }}>
          <Stack gap="lg">
            <WorkbenchPanel label="Appearance">
              <Text size="sm">Choose an appearance or follow your device setting.</Text>
              <SegmentedControl
                aria-label="Color scheme"
                value={colorScheme}
                onChange={(value) => setColorScheme(value as "light" | "dark" | "auto")}
                data={[
                  { value: "light", label: "Light" },
                  { value: "dark", label: "Dark" },
                  { value: "auto", label: "System" },
                ]}
              />
            </WorkbenchPanel>
            <WorkbenchPanel label="Connection and pairing">
              <Text size="sm">Local host · {status}</Text>
              <Text size="xs" c="dimmed" ff="monospace">
                {window.location.origin}
              </Text>
              {error && <Alert color="yellow">{error}</Alert>}
              <Button w="fit-content" onClick={onReconnect}>
                Reconnect
              </Button>
            </WorkbenchPanel>
            <WorkbenchPanel label="Session history">
              <Text size="sm">
                Open a selected run's agent session to load older history, select attempts, search
                speakers, and follow new activity.
              </Text>
              <Button w="fit-content" onClick={onOpenSession}>
                Open agent session
              </Button>
              <Text size="xs" c="dimmed" ff="monospace">
                Reading older messages preserves your position.
              </Text>
            </WorkbenchPanel>
          </Stack>
        </Grid.Col>
      </Grid>
    </Stack>
  );
}
