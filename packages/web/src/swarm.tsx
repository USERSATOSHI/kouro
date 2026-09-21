import { useEffect, useState } from "react";
import { isHarnessId } from "@kouro/core";
import type { HarnessId } from "@kouro/core";

export type SwarmParticipant = {
  id: string;
  name: string;
  role: string;
  harness?: HarnessId;
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
      return {
        id: text(x.id),
        name: text(x.name, text(x.id, "participant")),
        role: text(x.role, "participant"),
        harness: isHarnessId(text(x.harness)) ? (text(x.harness) as HarnessId) : undefined,
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
        type: text(x.type, "finding"),
        title: text(x.title, "Untitled entry"),
        body: text(x.body, text(x.content)),
        authorId: text(x.authorId) || undefined,
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
  };
}

export function formatBudget(value?: { used: number; limit: number }, suffix = "") {
  if (!value || value.limit <= 0) return "—";
  return `${value.used} / ${value.limit}${suffix}`;
}

export function SwarmWorkbench({
  runId,
  fetchView,
}: {
  runId: string;
  fetchView: (runId: string) => Promise<unknown>;
}) {
  const [view, setView] = useState<CollaborationView>();
  const [error, setError] = useState<string>();
  const [selectedParticipant, setSelectedParticipant] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    void fetchView(runId)
      .then((raw) => {
        if (!cancelled) {
          setView(normalizeCollaboration(raw, runId));
          setError(undefined);
        }
      })
      .catch((cause) => {
        if (!cancelled)
          setError(cause instanceof Error ? cause.message : "Collaboration data unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, [fetchView, runId]);
  if (error)
    return (
      <section className="swarm-empty" role="status">
        <span className="eyebrow">COLLABORATION</span>
        <h1>Collaboration records unavailable</h1>
        <p>{error}</p>
      </section>
    );
  if (!view)
    return (
      <section className="swarm-empty">
        <div className="loader" />
        Loading durable collaboration records…
      </section>
    );
  const participant = view.participants.find((item) => item.id === selectedParticipant);
  const messages = participant
    ? view.messages.filter(
        (item) => item.senderId === participant.id || item.recipientIds.includes(participant.id),
      )
    : view.messages;
  return (
    <section className="swarm-workbench">
      <div className="swarm-header">
        <div>
          <span className="eyebrow">M6 · COLLABORATION</span>
          <h1>{view.objective}</h1>
          <p>
            {view.participants.length} participants · {view.channels.length} channels · durable run
            records
          </p>
        </div>
        <div className="swarm-budgets">
          <Budget label="MESSAGE TURNS" value={formatBudget(view.budgets.messageTurns)} />
          <Budget label="MESSAGES" value={formatBudget(view.budgets.messages)} />
          <Budget label="ELAPSED" value={formatBudget(view.budgets.elapsedMs, " ms")} />
        </div>
      </div>
      <div className="swarm-grid">
        <div className="swarm-panel swarm-participants">
          <PanelTitle title="Participants" detail="role · harness · model · state" />
          <div className="participant-list">
            {view.participants.map((item) => (
              <button
                key={item.id}
                className={`participant ${item.id === selectedParticipant ? "selected" : ""}`}
                onClick={() => setSelectedParticipant(item.id)}
              >
                <Status state={item.state} />
                <span>
                  <strong>{item.name}</strong>
                  <em>
                    {item.role} · {item.harness ?? "harness not recorded"}
                  </em>
                  <small>
                    {item.model ?? "model not recorded"} · {item.activity ?? item.state}
                  </small>
                </span>
              </button>
            ))}
          </div>
        </div>
        <div className="swarm-panel swarm-messages">
          <PanelTitle title="Direct message stream" detail="separate from workflow topology" />
          <div className="message-stream">
            {messages.length ? (
              messages.map((item) => (
                <article className="swarm-message" key={item.id}>
                  <div className="message-meta">
                    <b>{item.senderId}</b>
                    <span>
                      {item.type ?? "message"} ·{" "}
                      {item.createdAt
                        ? new Date(item.createdAt).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })
                        : "time not recorded"}
                    </span>
                  </div>
                  <p>{item.body}</p>
                  <div className="message-links">
                    to {item.recipientIds.join(", ") || "channel"}
                    {item.senderAttemptId && (
                      <>
                        {" "}
                        · sender attempt <code>{item.senderAttemptId}</code>
                      </>
                    )}
                    {item.recipientContextIds?.length ? (
                      <> · context {item.recipientContextIds.join(", ")}</>
                    ) : null}
                  </div>
                </article>
              ))
            ) : (
              <div className="empty-inline">No messages recorded for this participant.</div>
            )}
          </div>
        </div>
        <div className="swarm-panel swarm-blackboard">
          <PanelTitle
            title="Blackboard & artifacts"
            detail={`${view.blackboard.length} typed entries · ${view.artifacts.length} artifacts`}
          />
          {view.blackboard.map((item) => (
            <article className="board-entry" key={item.id}>
              <span className={`entry-type ${item.type}`}>{item.type}</span>
              <strong>{item.title}</strong>
              <p>{item.body}</p>
              <small>
                {item.authorId ?? "author not recorded"} · {item.status ?? "active"}
              </small>
            </article>
          ))}
          {view.artifacts.map((item) => (
            <div className="artifact-row" key={item.id}>
              ◈{" "}
              <span>
                <strong>{item.name}</strong>
                <em>
                  {item.kind ?? item.contentType ?? "artifact"} ·{" "}
                  {item.producerId ?? "producer not recorded"}
                </em>
              </span>
            </div>
          ))}
        </div>
        <div className="swarm-panel swarm-timeline">
          <PanelTitle
            title="Participant timeline"
            detail={participant ? participant.name : "all participants"}
          />
          <div className="timeline-events">
            {view.timeline
              .filter((event) => !participant || event.participantId === participant.id)
              .map((event) => (
                <div className="timeline-event" key={event.id}>
                  <Status state={event.type} />
                  <span>
                    <strong>{event.label}</strong>
                    <em>
                      {event.participantId} · {event.at}
                    </em>
                  </span>
                </div>
              ))}
          </div>
        </div>
      </div>
    </section>
  );
}
function PanelTitle({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="swarm-panel-heading">
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  );
}
function Budget({ label, value }: { label: string; value: string }) {
  return (
    <div className="swarm-budget">
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}
function Status({ state }: { state: string }) {
  return <i className={`swarm-status swarm-${state}`} aria-label={state} />;
}
