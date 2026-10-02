import { Anchor, Box, Code, Group, Paper, Stack, Text } from "@mantine/core";
import { Disclosure, DisclosureTitle } from "./Disclosure";
/** Bounded, text-only presentation for tool arguments, results and structured logs. */
export function ActivityValue({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (typeof value === "string") {
    const text = value.length > 20000 ? `${value.slice(0, 20000)}\n… preview truncated` : value;
    if (depth < 5 && value.length <= 20000 && /^[\s]*[[{]/.test(value)) {
      try {
        return <ActivityValue value={JSON.parse(value)} depth={depth + 1} />;
      } catch {
        /* Plain provider text. */
      }
    }
    return (
      <Code block mah={380} style={{ overflow: "auto" }} className="activity-text">
        {text}
      </Code>
    );
  }
  if (value === null || value === undefined)
    return (
      <Text component="span" size="sm" c="dimmed" className="muted">
        No value
      </Text>
    );
  if (typeof value !== "object")
    return (
      <Text component="span" size="sm">
        {String(value)}
      </Text>
    );
  if (depth >= 5)
    return (
      <Text component="span" size="sm" c="dimmed" className="muted">
        Additional nested details omitted from preview.
      </Text>
    );
  if (Array.isArray(value))
    return (
      <Stack gap="xs" className="activity-list">
        {value.slice(0, 100).map((item, index) => (
          <Stack gap="xs" key={index}>
            <ActivityValue value={item} depth={depth + 1} />
          </Stack>
        ))}
        {value.length > 100 && (
          <Text component="span" size="xs" c="dimmed">
            {value.length - 100} additional items omitted from preview.
          </Text>
        )}
      </Stack>
    );
  const fields = Object.entries(value);
  // MCP text content is ordinary output, with no need to expose its envelope.
  if ("type" in value && (value.type === "text" || value.type === "inputText") && "text" in value)
    return <ActivityValue value={value.text} depth={depth + 1} />;
  return (
    <Box m={0} component="dl" className="activity-fields">
      {fields.slice(0, 40).map(([key, item]) => (
        <Stack gap="xs" key={key}>
          <Box m={0} component="dt">
            {key.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ")}
          </Box>
          <Box m={0} component="dd">
            <ActivityValue value={item} depth={depth + 1} />
          </Box>
        </Stack>
      ))}
      {fields.length > 40 && (
        <Text component="span" size="xs" c="dimmed">
          Additional fields omitted from preview.
        </Text>
      )}
    </Box>
  );
}

export interface ToolActivityData {
  name: string;
  status: string;
  input?: unknown;
  output?: unknown;
  outputArtifactId?: string;
  outputBytes?: number;
  error?: string;
  scoutId?: string;
}

export function ToolActivity({ tool }: { tool: ToolActivityData }) {
  return (
    <Paper component="article" className={`session-tool tool-${tool.status}`}>
      <Stack gap="md">
        <Group gap="xs" justify="space-between" wrap="wrap" component="header">
          <Text component="span" size="sm" fw={600}>
            {tool.scoutId ? `${tool.scoutId} · ` : ""}
            {tool.name}
          </Text>
          <Text component="span" size="sm">
            {tool.status}
          </Text>
        </Group>
        {tool.input !== undefined && (
          <Disclosure open>
            <DisclosureTitle>Input</DisclosureTitle>
            <ActivityValue value={tool.input} />
          </Disclosure>
        )}
        {tool.output !== undefined ? (
          <Stack
            gap="xs"
            component="section"
            className="tool-output"
            aria-label={`${tool.name} output`}
          >
            <Text component="span" size="sm" fw={600}>
              Output
            </Text>
            <ActivityValue value={tool.output} />
          </Stack>
        ) : (
          <Text size="sm" className="tool-output-pending">
            {tool.status === "running" || tool.status === "started"
              ? "Waiting for output…"
              : "No output was reported."}
          </Text>
        )}
        {tool.error && (
          <Text size="sm" className="session-error">
            {tool.error}
          </Text>
        )}
        {tool.outputArtifactId && (
          <Anchor
            className="diff-link"
            href={`/api/artifacts/${encodeURIComponent(tool.outputArtifactId)}/content`}
            target="_blank"
            rel="noreferrer"
          >
            Download full output
            {tool.outputBytes ? ` (${Math.ceil(tool.outputBytes / 1024)} KiB)` : ""} ↗
          </Anchor>
        )}
      </Stack>
    </Paper>
  );
}
