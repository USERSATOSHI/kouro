import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ActivityValue, ToolActivity } from "./ActivityValue";
import { projectSession, type SessionObservation, type SessionEntry } from "../session";

export interface ActivityPage {
  items: SessionObservation[];
  nextCursor: number;
  hasMore: boolean;
}

export function AgentSessionModal({
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
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
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
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    const handleDialogKeys = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (
        event.shiftKey &&
        (document.activeElement === first || !dialog.contains(document.activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || !dialog.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleDialogKeys);
    return () => {
      window.removeEventListener("keydown", handleDialogKeys);
      previousFocusRef.current?.focus();
    };
  }, []);
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
  return (
    <div
      className={`agent-session-backdrop${fullscreen ? " session-fullscreen" : ""}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        tabIndex={-1}
        className="agent-session-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-session-title"
      >
        <header className="agent-session-header">
          <div>
            <span>{live ? "LIVE AGENT SESSION" : "AGENT SESSION"}</span>
            <h2 id="agent-session-title">{nodeId}</h2>
            <small>
              {harness} · invocation {invocationId.slice(0, 12)} · attempt {attemptId.slice(0, 12)}
            </small>
            <button
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
            </button>
          </div>
          <div className="session-window-controls">
            <button
              type="button"
              className="session-size-toggle"
              aria-pressed={fullscreen}
              onClick={() => setFullscreen((current) => !current)}
            >
              {fullscreen ? "Exit fullscreen" : "Fullscreen"}
            </button>
            <button
              ref={closeButtonRef}
              type="button"
              aria-label="Close agent session"
              onClick={onClose}
            >
              ×
            </button>
          </div>
        </header>
        {summariesOnly && (
          <p className="session-provider-note">
            The provider has supplied reasoning summaries; full thinking text has not been provided.
            Assistant messages appear as they arrive.
          </p>
        )}
        {hasMoreHistory && (
          <button
            type="button"
            className="session-history-more"
            onClick={() => void loadMore()}
            disabled={historyLoading}
          >
            {historyLoading ? "Loading history…" : "Load more session history"}
          </button>
        )}
        {historyError && (
          <p className="session-history-error" role="status">
            {historyError}{" "}
            <button type="button" onClick={() => void loadMore()}>
              Retry
            </button>
          </p>
        )}
        <div className="session-search-row">
          <button
            type="button"
            aria-pressed={showSplit}
            disabled={!child}
            onClick={() => setSplit((value) => !value)}
          >
            {showSplit ? "Combined view" : "Split parent and subagent"}
          </button>
          {!showSplit && (
            <select
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
                ...new Set(
                  activeEntries.flatMap((entry) => (entry.scoutId ? [entry.scoutId] : [])),
                ),
              ].map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          )}
          <input
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
            <button
              type="button"
              onClick={() => {
                stickToBottom.current = false;
                setWindowStart(Math.max(0, windowStart - windowSize));
              }}
            >
              Earlier messages
            </button>
          )}
          {!showSplit && visibleStart + windowSize < filteredEntries.length && (
            <button
              type="button"
              onClick={() =>
                setWindowStart(
                  Math.min(filteredEntries.length - windowSize, windowStart + windowSize),
                )
              }
            >
              Newer messages
            </button>
          )}
          {search && <span>{filteredEntries.length} matches</span>}
        </div>
        {showSplit && child ? (
          <div className="session-split" data-testid="session-split">
            <section className="session-lane" aria-label="Main model session">
              <header>
                <strong>Main model</strong>
                <small>
                  {harness} · {live ? "live" : "completed"}
                </small>
              </header>
              <SessionLane entries={parentEntries} search={search} />
            </section>
            <section className="session-lane" aria-label="Subagent model session">
              <header>
                <label>
                  Subagent{" "}
                  <select
                    aria-label="Live subagent"
                    value={child.key}
                    onChange={(event) => setSelectedChild(event.target.value)}
                  >
                    {childLanes.map((lane) => (
                      <option key={lane.key} value={lane.key}>
                        {lane.scoutId} · {lane.requestId || "retained"}
                      </option>
                    ))}
                  </select>
                </label>
                <small>
                  {child.harness ?? "Harness not recorded"}
                  {child.modelId ? ` · ${child.modelId}` : ""} · {child.state}
                </small>
              </header>
              <SessionLane key={child.key} entries={childEntries} search={search} />
            </section>
          </div>
        ) : (
          <>
            {" "}
            <div
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
                <p className="agent-session-empty">
                  {live
                    ? "Waiting for agent activity…"
                    : "No provider activity was retained for this attempt."}
                </p>
              )}
              {visibleEntries.map((entry) => (
                <SessionEntryView key={entry.id} entry={entry} />
              ))}
            </div>
          </>
        )}
        {!showSplit && newActivity && (
          <button
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
          </button>
        )}
        {live && (
          <form className="session-composer" onSubmit={(event) => void sendSteering(event)}>
            <textarea
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
            <button type="submit" disabled={!steerable || !message.trim() || steering}>
              {steering ? "Sending…" : "Send instruction"}
            </button>
            {canInterrupt && (
              <button
                type="button"
                className="control-button"
                disabled={interruptPending || stopPending}
                onClick={onInterrupt}
              >
                {interruptPending ? "Interrupting…" : "Interrupt agent"}
              </button>
            )}
            {canStop && (
              <button
                className="session-stop"
                type="button"
                onClick={onStop}
                disabled={stopPending}
              >
                {stopPending ? "Cancelling…" : "Cancel run"}
              </button>
            )}
          </form>
        )}
        {steeringError && (
          <p className="session-error" role="alert">
            {steeringError}
          </p>
        )}
      </section>
    </div>
  );
}

function SessionEntryView({ entry }: { entry: SessionEntry }) {
  if (entry.kind === "tool") return <ToolActivity tool={entry} />;
  if (entry.kind === "status") return <p className="session-status">{entry.message}</p>;
  return (
    <article className={`session-message ${entry.channel ?? "agent"}-message`}>
      <span>
        {entry.scoutId ? `${entry.scoutId} · ` : ""}
        {entry.channel === "thinking"
          ? entry.thinkingKind === "content"
            ? "THINKING"
            : "THINKING SUMMARY"
          : entry.channel === "operator"
            ? `YOU · ${entry.status ?? "requested"}`
            : "AGENT"}
        <button
          type="button"
          onClick={() => void navigator.clipboard?.writeText(entry.text).catch(() => {})}
        >
          Copy
        </button>
      </span>
      {entry.channel !== "thinking" && /^\s*[[{]/.test(entry.text) ? (
        <ActivityValue value={entry.text} />
      ) : (
        <SafeMarkdown text={entry.text} />
      )}
    </article>
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
      <div className="lane-navigation">
        {offset > 0 && (
          <button
            onClick={() => {
              following.current = false;
              setStart(Math.max(0, offset - size));
            }}
          >
            Earlier messages
          </button>
        )}
        {offset + size < entries.length && (
          <button
            onClick={() => {
              following.current = false;
              setStart(offset + size);
            }}
          >
            Newer messages
          </button>
        )}
        {newActivity && (
          <button
            onClick={() => {
              following.current = true;
              setStart(Math.max(0, entries.length - size));
              stream.current?.scrollTo({ top: stream.current.scrollHeight });
              setNewActivity(false);
            }}
          >
            Jump to latest
          </button>
        )}
      </div>
      <div
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
          <p className="agent-session-empty">
            {search ? "No activity matches the search." : "Waiting for activity…"}
          </p>
        )}
      </div>
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
            <strong className="session-markdown-heading" key={`h-${index}-${lineIndex}`}>
              {inlineMarkdown(heading)}
            </strong>,
          );
        } else {
          rendered.push(
            <span key={`p-${index}-${lineIndex}`}>
              {inlineMarkdown(line)}
              {lineIndex < plain!.split("\n").length - 1 ? <br /> : null}
            </span>,
          );
        }
      });
    }
    if (parts[index + 2] !== undefined)
      rendered.push(
        <pre className="session-code-block" key={`c-${index}`}>
          <code>{parts[index + 2]}</code>
        </pre>,
      );
  }
  return <div className="session-markdown">{rendered}</div>;
}

function inlineMarkdown(line: string): ReactNode[] {
  const tokens = line.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g);
  return tokens.map((token, index) => {
    if (token.startsWith("**") && token.endsWith("**"))
      return <strong key={index}>{token.slice(2, -2)}</strong>;
    if (token.startsWith("*") && token.endsWith("*"))
      return <em key={index}>{token.slice(1, -1)}</em>;
    if (token.startsWith("`") && token.endsWith("`"))
      return <code key={index}>{token.slice(1, -1)}</code>;
    const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link) {
      try {
        const url = new URL(link[2]!, window.location.href);
        if (url.protocol === "http:" || url.protocol === "https:")
          return (
            <a key={index} href={url.href} target="_blank" rel="noreferrer">
              {link[1]}
            </a>
          );
      } catch {
        // Invalid and unsafe links stay visible as text.
      }
    }
    return <span key={index}>{token}</span>;
  });
}
