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
    return <pre className="activity-text">{text}</pre>;
  }
  if (value === null || value === undefined) return <span className="muted">No value</span>;
  if (typeof value !== "object") return <span>{String(value)}</span>;
  if (depth >= 5)
    return <span className="muted">Additional nested details omitted from preview.</span>;
  if (Array.isArray(value))
    return (
      <div className="activity-list">
        {value.slice(0, 100).map((item, index) => (
          <div key={index}>
            <ActivityValue value={item} depth={depth + 1} />
          </div>
        ))}
        {value.length > 100 && (
          <small>{value.length - 100} additional items omitted from preview.</small>
        )}
      </div>
    );
  const fields = Object.entries(value);
  // MCP text content is ordinary output, with no need to expose its envelope.
  if ("type" in value && (value.type === "text" || value.type === "inputText") && "text" in value)
    return <ActivityValue value={value.text} depth={depth + 1} />;
  return (
    <dl className="activity-fields">
      {fields.slice(0, 40).map(([key, item]) => (
        <div key={key}>
          <dt>{key.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ")}</dt>
          <dd>
            <ActivityValue value={item} depth={depth + 1} />
          </dd>
        </div>
      ))}
      {fields.length > 40 && <small>Additional fields omitted from preview.</small>}
    </dl>
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
    <article className={`session-tool tool-${tool.status}`}>
      <header>
        <strong>
          {tool.scoutId ? `${tool.scoutId} · ` : ""}
          {tool.name}
        </strong>
        <span>{tool.status}</span>
      </header>
      {tool.input !== undefined && (
        <details open>
          <summary>Input</summary>
          <ActivityValue value={tool.input} />
        </details>
      )}
      {tool.output !== undefined ? (
        <section className="tool-output" aria-label={`${tool.name} output`}>
          <strong>Output</strong>
          <ActivityValue value={tool.output} />
        </section>
      ) : (
        <p className="tool-output-pending">
          {tool.status === "running" || tool.status === "started"
            ? "Waiting for output…"
            : "No output was reported."}
        </p>
      )}
      {tool.error && <p className="session-error">{tool.error}</p>}
      {tool.outputArtifactId && (
        <a
          className="diff-link"
          href={`/api/artifacts/${encodeURIComponent(tool.outputArtifactId)}/content`}
          target="_blank"
          rel="noreferrer"
        >
          Download full output
          {tool.outputBytes ? ` (${Math.ceil(tool.outputBytes / 1024)} KiB)` : ""} ↗
        </a>
      )}
    </article>
  );
}
