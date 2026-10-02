import { Modal, Paper, Badge, Divider } from "@mantine/core";
import {
  Anchor,
  Button,
  Code,
  Group,
  NativeSelect,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Textarea,
  Title,
} from "@mantine/core";
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ActivityValue, ToolActivity } from "./ActivityValue";
import { projectSession, type SessionObservation, type SessionEntry } from "../session";

export interface ActivityPage {
  items: SessionObservation[];
  nextCursor: number;
  hasMore: boolean;
}

export function AgentSessionModal({
  embedded = false,
  runId,
  invocationId,
  attemptId,
  nodeId,
  harness,
  events,
  live,
  steerable,
  canStop,
  stopPending,
  onStop,
  canInterrupt = false,
  interruptPending = false,
  onInterrupt,
  onSteer,
  loadActivity,
  onClose,
  initialSpeaker,
  subagents = [],
}: {
  embedded?: boolean;
  runId: string;
  invocationId: string;
  attemptId: string;
  nodeId: string;
  harness: string;
  events: SessionObservation[];
  live: boolean;
  steerable: boolean;
  canStop: boolean;
  stopPending: boolean;
  onStop: () => void;
  canInterrupt?: boolean;
  interruptPending?: boolean;
  onInterrupt?: () => void;
  onSteer: (message: string) => Promise<boolean>;
  loadActivity: (runId: string, attemptId: string, after: number) => Promise<ActivityPage>;
  onClose: () => void;
  initialSpeaker: string;
  subagents?: Array<{
    scoutId: string;
    requestId: string;
    harness?: string;
    modelId?: string;
    state: string;
  }>;
}) {
  const [message, setMessage] = useState("");
  const [search, setSearch] = useState("");
  const [windowStart, setWindowStart] = useState(0);
  const [history, setHistory] = useState<SessionObservation[]>([]);
  const [historyCursor, setHistoryCursor] = useState(0);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string>();
  const [steering, setSteering] = useState(false);
  const [steeringError, setSteeringError] = useState<string>();
  const [speaker, setSpeaker] = useState(initialSpeaker);
  const [split, setSplit] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [selectedChild, setSelectedChild] = useState<string>();
  const [newActivity, setNewActivity] = useState(false);
  const streamRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const activeEntries = useMemo(() => projectSession([...history, ...events]), [history, events]);
  const summariesOnly =
    activeEntries.some((entry) => entry.kind === "message" && entry.thinkingKind === "summary") &&
    !activeEntries.some((entry) => entry.kind === "message" && entry.thinkingKind === "content");
  const childLanes = useMemo(() => {
    const lanes = new Map(subagents.map((agent) => [`${agent.scoutId}:${agent.requestId}`, agent]));
    for (const entry of activeEntries)
      if (entry.scoutId) {
        const key = `${entry.scoutId}:${entry.requestId ?? ""}`;
        if (!lanes.has(key))
          lanes.set(key, {
            scoutId: entry.scoutId,
            requestId: entry.requestId ?? "",
            state: "Activity retained",
          });
      }
    return [...lanes.entries()].map(([key, agent]) => ({ key, ...agent }));
  }, [activeEntries, subagents]);
  const child =
    childLanes.find((lane) => lane.key === selectedChild) ??
    childLanes.find((lane) => lane.scoutId === initialSpeaker) ??
    childLanes.find((lane) => lane.state === "running" || lane.state === "accepted") ??
    childLanes.at(-1);
  const showSplit = split && Boolean(child);
  const splitEntries = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    return term
      ? activeEntries.filter((entry) => JSON.stringify(entry).toLocaleLowerCase().includes(term))
      : activeEntries;
  }, [activeEntries, search]);
  const parentEntries = useMemo(
    () => splitEntries.filter((entry) => !entry.scoutId),
    [splitEntries],
  );
  const childEntries = useMemo(
    () =>
      splitEntries.filter(
        (entry) => entry.scoutId === child?.scoutId && (entry.requestId ?? "") === child?.requestId,
      ),
    [splitEntries, child?.scoutId, child?.requestId],
  );
  const filteredEntries = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    const matches = term
      ? activeEntries.filter((entry) => JSON.stringify(entry).toLocaleLowerCase().includes(term))
      : activeEntries;
    return matches.filter((entry) => speaker === "all" || (entry.scoutId ?? "parent") === speaker);
  }, [activeEntries, search, speaker]);
  const windowSize = 250;
  const visibleStart =
    !search && speaker === "all" && stickToBottom.current
      ? Math.max(0, filteredEntries.length - windowSize)
      : Math.min(windowStart, Math.max(0, filteredEntries.length - 1));
  const visibleEntries = filteredEntries.slice(visibleStart, visibleStart + windowSize);
  useEffect(() => {
    let cancelled = false;
    setHistory([]);
    setHistoryCursor(0);
    setHasMoreHistory(false);
    setHistoryLoading(true);
    setHistoryError(undefined);
    void loadActivity(runId, attemptId, 0)
      .then((page) => {
        if (!cancelled) {
          setHistory(page.items);
          setHistoryCursor(page.nextCursor);
          setHasMoreHistory(page.hasMore);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled)
          setHistoryError(
            cause instanceof Error ? cause.message : "Session history is unavailable",
          );
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [runId, attemptId, loadActivity]);
  useEffect(() => {
    const stream = streamRef.current;
    if (stream && stickToBottom.current) {
      if (!search && speaker === "all")
        setWindowStart(Math.max(0, activeEntries.length - windowSize));
      stream.scrollTop = stream.scrollHeight;
      setNewActivity(false);
    } else if (events.length) setNewActivity(true);
  }, [activeEntries, windowStart, search, speaker]);
  const loadMore = async () => {
    if (historyLoading || (!hasMoreHistory && !historyError)) return;
    setHistoryLoading(true);
    setHistoryError(undefined);
    try {
      const page = await loadActivity(runId, attemptId, historyCursor);
      setHistory((current) => [...current, ...page.items]);
      setHistoryCursor(page.nextCursor);
      setHasMoreHistory(page.hasMore);
    } catch (cause) {
      setHistoryError(
        cause instanceof Error ? cause.message : "Unable to load more session history",
      );
    } finally {
      setHistoryLoading(false);
    }
  };
  const sendSteering = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = message.trim();
    if (!value || steering || !steerable) return;
    setSteering(true);
    setSteeringError(undefined);
    try {
      if (await onSteer(value)) setMessage("");
      else
        setSteeringError(
          "Instruction was not confirmed. Check the run's activity before retrying.",
        );
    } catch (cause) {
      setSteeringError(cause instanceof Error ? cause.message : "Unable to send instruction");
    } finally {
      setSteering(false);
    }
  };
  const content = (
    <Stack gap="md">
      <Group
        gap="xs"
        justify="space-between"
        wrap="wrap"
        component="header"
        className="agent-session-header"
      >
        <Stack gap="xs">
          <Text component="span" size="sm">
            {live ? "LIVE AGENT SESSION" : "AGENT SESSION"}
          </Text>
          <Title order={2} id="agent-session-title">
            {nodeId}
          </Title>
          <Text component="span" size="xs" c="dimmed">
            {harness} · invocation {invocationId.slice(0, 12)} · attempt {attemptId.slice(0, 12)}
          </Text>
          <Button
            type="button"
            className="session-copy-link"
            onClick={() => {
              const url = new URL(window.location.href);
              url.searchParams.set("run", runId);
              url.searchParams.set("invocation", invocationId);
              url.searchParams.set("attempt", attemptId);
              void navigator.clipboard?.writeText(url.toString());
            }}
          >
            Copy session link
          </Button>
        </Stack>
        <Group gap="xs" justify="space-between" wrap="wrap" className="session-window-controls">
          <Button
            type="button"
            className="session-size-toggle"
            aria-pressed={fullscreen}
            onClick={() => setFullscreen((current) => !current)}
          >
            {fullscreen ? "Exit fullscreen" : "Fullscreen"}
          </Button>
        </Group>
      </Group>
      {summariesOnly && (
        <Text size="sm" className="session-provider-note">
          The provider has supplied reasoning summaries; full thinking text has not been provided.
          Assistant messages appear as they arrive.
        </Text>
      )}
      {hasMoreHistory && (
        <Button
          type="button"
          className="session-history-more"
          onClick={() => void loadMore()}
          disabled={historyLoading}
        >
          {historyLoading ? "Loading history…" : "Load more session history"}
        </Button>
      )}
      {historyError && (
        <Text size="sm" className="session-history-error" role="status">
          {historyError}{" "}
          <Button type="button" onClick={() => void loadMore()}>
            Retry
          </Button>
        </Text>
      )}
      <Group gap="xs" justify="space-between" wrap="wrap" className="session-search-row">
        <Button
          type="button"
          aria-pressed={showSplit}
          disabled={!child}
          onClick={() => setSplit((value) => !value)}
        >
          {showSplit ? "Combined view" : "Split parent and subagent"}
        </Button>
        {!showSplit && (
          <NativeSelect
            aria-label="Session speaker"
            value={speaker}
            onChange={(event) => {
              stickToBottom.current = false;
              setWindowStart(0);
              setSpeaker(event.target.value);
            }}
          >
            <option value="all">Parent and subagents</option>
            <option value="parent">Parent only</option>
            {[
              ...new Set(activeEntries.flatMap((entry) => (entry.scoutId ? [entry.scoutId] : []))),
            ].map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </NativeSelect>
        )}
        <TextInput
          aria-label="Search agent session"
          placeholder="Search this session"
          value={search}
          onChange={(event) => {
            stickToBottom.current = false;
            setWindowStart(0);
            setSearch(event.target.value);
          }}
        />
        {!showSplit && visibleStart > 0 && (
          <Button
            type="button"
            onClick={() => {
              stickToBottom.current = false;
              setWindowStart(Math.max(0, windowStart - windowSize));
            }}
          >
            Earlier messages
          </Button>
        )}
        {!showSplit && visibleStart + windowSize < filteredEntries.length && (
          <Button
            type="button"
            onClick={() =>
              setWindowStart(
                Math.min(filteredEntries.length - windowSize, windowStart + windowSize),
              )
            }
          >
            Newer messages
          </Button>
        )}
        {search && (
          <Text component="span" size="sm">
            {filteredEntries.length} matches
          </Text>
        )}
      </Group>
      {showSplit && child ? (
        <SimpleGrid
          cols={{ base: 1, md: 2 }}
          spacing="md"
          className="session-split"
          data-testid="session-split"
        >
          <Paper component="section" className="session-lane" aria-label="Main model session">
            <Stack gap="md">
              <Group gap="xs" justify="space-between" wrap="wrap" component="header">
                <Text component="span" size="sm" fw={600}>
                  Main model
                </Text>
                <Text component="span" size="xs" c="dimmed">
                  {harness} · {live ? "live" : "completed"}
                </Text>
              </Group>
              <SessionLane entries={parentEntries} search={search} />
            </Stack>
          </Paper>
          <Paper component="section" className="session-lane" aria-label="Subagent model session">
            <Stack gap="md">
              <Group gap="xs" justify="space-between" wrap="wrap" component="header">
                <Stack gap={4} component="label">
                  Subagent{" "}
                  <NativeSelect
                    aria-label="Live subagent"
                    value={child.key}
                    onChange={(event) => setSelectedChild(event.target.value)}
                  >
                    {childLanes.map((lane) => (
                      <option key={lane.key} value={lane.key}>
                        {lane.scoutId} · {lane.requestId || "retained"}
                      </option>
                    ))}
                  </NativeSelect>
                </Stack>
                <Text component="span" size="xs" c="dimmed">
                  {child.harness ?? "Harness not recorded"}
                  {child.modelId ? ` · ${child.modelId}` : ""} · {child.state}
                </Text>
              </Group>
              <SessionLane key={child.key} entries={childEntries} search={search} />
            </Stack>
          </Paper>
        </SimpleGrid>
      ) : (
        <>
          {" "}
          <Stack
            gap="sm"
            h="min(50dvh, 600px)"
            p="sm"
            style={{ overflow: "auto" }}
            className="agent-session-stream"
            ref={streamRef}
            onScroll={(event) => {
              const el = event.currentTarget;
              stickToBottom.current =
                !search &&
                speaker === "all" &&
                visibleStart + windowSize >= filteredEntries.length &&
                el.scrollHeight - el.scrollTop - el.clientHeight < 80;
              if (stickToBottom.current) setNewActivity(false);
            }}
          >
            {visibleEntries.length === 0 && (
              <Text size="sm" className="agent-session-empty">
                {live
                  ? "Waiting for agent activity…"
                  : "No provider activity was retained for this attempt."}
              </Text>
            )}
            {visibleEntries.map((entry) => (
              <SessionEntryView key={entry.id} entry={entry} />
            ))}
          </Stack>
        </>
      )}
      {!showSplit && newActivity && (
        <Button
          type="button"
          className="session-jump-latest"
          onClick={() => {
            stickToBottom.current = true;
            setSearch("");
            setSpeaker("all");
            setWindowStart(Math.max(0, activeEntries.length - windowSize));
            streamRef.current?.scrollTo({
              top: streamRef.current.scrollHeight,
              behavior: "smooth",
            });
            setNewActivity(false);
          }}
        >
          New activity · Jump to latest
        </Button>
      )}
      {live && (
        <Stack
          gap="xs"
          component="form"
          className="session-composer"
          onSubmit={(event) => void sendSteering(event as unknown as FormEvent<HTMLFormElement>)}
        >
          <Textarea
            minRows={3}
            autosize
            maxRows={12}
            aria-label="Steer active agent"
            placeholder={
              steerable
                ? "Send an instruction while it is running…"
                : "This harness cannot be steered mid-turn"
            }
            disabled={!steerable}
            value={message}
            maxLength={4000}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            onChange={(event) => setMessage(event.target.value)}
          />
          <Button type="submit" disabled={!steerable || !message.trim() || steering}>
            {steering ? "Sending…" : "Send instruction"}
          </Button>
          {canInterrupt && (
            <Button
              type="button"
              className="control-button"
              disabled={interruptPending || stopPending}
              onClick={onInterrupt}
            >
              {interruptPending ? "Interrupting…" : "Interrupt agent"}
            </Button>
          )}
          {canStop && (
            <Button className="session-stop" type="button" onClick={onStop} disabled={stopPending}>
              {stopPending ? "Cancelling…" : "Cancel run"}
            </Button>
          )}
        </Stack>
      )}
      {steeringError && (
        <Text size="sm" className="session-error" role="alert">
          {steeringError}
        </Text>
      )}
    </Stack>
  );
  return embedded && !fullscreen ? (
    <Paper>{content}</Paper>
  ) : (
    <Modal
      opened
      onClose={embedded ? () => setFullscreen(false) : onClose}
      fullScreen={fullscreen}
      size="min(1320px, 95vw)"
      title={`${live ? "Live agent session" : "Agent session"} · ${nodeId}`}
      closeButtonProps={{ "aria-label": "Close agent session" }}
      className="agent-session-modal"
    >
      {content}
    </Modal>
  );
}

function SessionEntryView({ entry }: { entry: SessionEntry }) {
  if (entry.kind === "tool") return <ToolActivity tool={entry} />;
  if (entry.kind === "status")
    return (
      <Text size="sm" className="session-status">
        {entry.message}
      </Text>
    );
  return (
    <Paper
      p="sm"
      component="article"
      className={`session-message ${entry.channel ?? "agent"}-message`}
    >
      <Stack gap="md">
        <Text component="span" size="sm">
          {entry.scoutId ? `${entry.scoutId} · ` : ""}
          {entry.channel === "thinking"
            ? entry.thinkingKind === "content"
              ? "THINKING"
              : "THINKING SUMMARY"
            : entry.channel === "operator"
              ? `YOU · ${entry.status ?? "requested"}`
              : "AGENT"}
          <Button
            type="button"
            onClick={() => void navigator.clipboard?.writeText(entry.text).catch(() => {})}
          >
            Copy
          </Button>
        </Text>
        {entry.channel !== "thinking" && /^\s*[[{]/.test(entry.text) ? (
          <ActivityValue value={entry.text} />
        ) : (
          <SafeMarkdown text={entry.text} />
        )}
      </Stack>
    </Paper>
  );
}

function SessionLane({ entries, search }: { entries: SessionEntry[]; search: string }) {
  const size = 250;
  const [start, setStart] = useState(Math.max(0, entries.length - size));
  const [newActivity, setNewActivity] = useState(false);
  const following = useRef(true);
  const stream = useRef<HTMLDivElement>(null);
  const offset =
    following.current && !search
      ? Math.max(0, entries.length - size)
      : Math.min(start, Math.max(0, entries.length - 1));
  useEffect(() => {
    setStart(0);
    following.current = !search;
  }, [search]);
  useEffect(() => {
    if (following.current && !search) {
      setStart(Math.max(0, entries.length - size));
      stream.current?.scrollTo({ top: stream.current.scrollHeight });
      setNewActivity(false);
    } else setNewActivity(true);
  }, [entries, search]);
  return (
    <>
      <Group gap="xs" justify="space-between" wrap="wrap" className="lane-navigation">
        {offset > 0 && (
          <Button
            onClick={() => {
              following.current = false;
              setStart(Math.max(0, offset - size));
            }}
          >
            Earlier messages
          </Button>
        )}
        {offset + size < entries.length && (
          <Button
            onClick={() => {
              following.current = false;
              setStart(offset + size);
            }}
          >
            Newer messages
          </Button>
        )}
        {newActivity && (
          <Button
            onClick={() => {
              following.current = true;
              setStart(Math.max(0, entries.length - size));
              stream.current?.scrollTo({ top: stream.current.scrollHeight });
              setNewActivity(false);
            }}
          >
            Jump to latest
          </Button>
        )}
      </Group>
      <Stack
        gap="sm"
        h="min(50dvh, 600px)"
        p="sm"
        style={{ overflow: "auto" }}
        ref={stream}
        className="agent-session-stream"
        onScroll={(event) => {
          const el = event.currentTarget;
          following.current =
            !search &&
            offset + size >= entries.length &&
            el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {entries.slice(offset, offset + size).map((entry) => (
          <SessionEntryView key={entry.id} entry={entry} />
        ))}
        {!entries.length && (
          <Text size="sm" className="agent-session-empty">
            {search ? "No activity matches the search." : "Waiting for activity…"}
          </Text>
        )}
      </Stack>
    </>
  );
}

function displayActivity(value: unknown) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export function boundedActivity(value: unknown): string {
  const text = displayActivity(value);
  return text.length > 20_000
    ? `${text.slice(0, 20_000)}\n… output preview truncated; download the artifact for the complete result.`
    : text;
}

export function SafeMarkdown({ text }: { text: string }) {
  const parts = text.split(/```([^\n]*)\n([\s\S]*?)```/g);
  const rendered: ReactNode[] = [];
  for (let index = 0; index < parts.length; index += 3) {
    const plain = parts[index];
    if (plain) {
      plain.split("\n").forEach((line, lineIndex) => {
        if (/^\s{0,3}#{1,4}\s/.test(line)) {
          const heading = line.replace(/^\s{0,3}#{1,4}\s/, "");
          rendered.push(
            <Text
              component="span"
              size="sm"
              fw={600}
              className="session-markdown-heading"
              key={`h-${index}-${lineIndex}`}
            >
              {inlineMarkdown(heading)}
            </Text>,
          );
        } else {
          rendered.push(
            <Text component="span" size="sm" key={`p-${index}-${lineIndex}`}>
              {inlineMarkdown(line)}
              {lineIndex < plain!.split("\n").length - 1 ? <br /> : null}
            </Text>,
          );
        }
      });
    }
    if (parts[index + 2] !== undefined)
      rendered.push(
        <Code
          block
          mah={380}
          style={{ overflow: "auto" }}
          className="session-code-block"
          key={`c-${index}`}
        >
          <Code>{parts[index + 2]}</Code>
        </Code>,
      );
  }
  return (
    <Stack gap="xs" className="session-markdown">
      {rendered}
    </Stack>
  );
}

function inlineMarkdown(line: string): ReactNode[] {
  const tokens = line.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g);
  return tokens.map((token, index) => {
    if (token.startsWith("**") && token.endsWith("**"))
      return (
        <Text component="span" size="sm" fw={600} key={index}>
          {token.slice(2, -2)}
        </Text>
      );
    if (token.startsWith("*") && token.endsWith("*"))
      return (
        <Text component="span" size="sm" c="dimmed" key={index}>
          {token.slice(1, -1)}
        </Text>
      );
    if (token.startsWith("`") && token.endsWith("`"))
      return <Code key={index}>{token.slice(1, -1)}</Code>;
    const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link) {
      try {
        const url = new URL(link[2]!, window.location.href);
        if (url.protocol === "http:" || url.protocol === "https:")
          return (
            <Anchor key={index} href={url.href} target="_blank" rel="noreferrer">
              {link[1]}
            </Anchor>
          );
      } catch {
        // Invalid and unsafe links stay visible as text.
      }
    }
    return (
      <Text component="span" size="sm" key={index}>
        {token}
      </Text>
    );
  });
}
