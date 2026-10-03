import { randomUUID } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

interface HostConnection {
  protocol: 1;
  url: string;
  token: string;
  instanceId: string;
}

/** Private rendezvous for clients of the single owner of this data directory. */
export async function registerHost(dataDir: string, connection: HostConnection) {
  const path = join(dataDir, "host.json");
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(connection), { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return async () => {
    const current = JSON.parse(await readFile(path, "utf8").catch(() => "null"));
    if (current?.instanceId === connection.instanceId) await rm(path, { force: true });
  };
}

export async function findHost(dataDir: string): Promise<HostConnection | undefined> {
  const path = join(dataDir, "host.json");
  let connection: HostConnection;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.mode & 0o077 || info.uid !== process.getuid?.())
      throw new Error("Kouro host connection file must be owned by you and private (mode 600)");
    connection = JSON.parse(await readFile(path, "utf8"));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
  const url = new URL(connection.url);
  if (
    connection.protocol !== 1 ||
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    typeof connection.token !== "string" ||
    typeof connection.instanceId !== "string"
  )
    throw new Error("Invalid Kouro host connection file");
  let response: Response;
  try {
    response = await fetch(`${connection.url}/api/cli/host`, {
      headers: { authorization: `Bearer ${connection.token}` },
      signal: AbortSignal.timeout(2000),
      redirect: "error",
    });
  } catch (cause) {
    if (["ECONNREFUSED", "ConnectionRefused"].includes((cause as NodeJS.ErrnoException).code ?? ""))
      return undefined;
    throw new Error("Cannot reach the Kouro host owning this data directory", { cause });
  }
  if (!response.ok || (await response.json()).instanceId !== connection.instanceId)
    throw new Error("Kouro host connection is stale; use the running host's current CLI version");
  return connection;
}

export function dashboardUrl(connection: Pick<HostConnection, "url" | "token">) {
  return `${connection.url}/#token=${encodeURIComponent(connection.token)}`;
}

export async function connectedTaskCommand(
  connection: HostConnection,
  argv: string[],
  write: (value: unknown) => void = (value) => process.stdout.write(`${JSON.stringify(value)}\n`),
): Promise<number> {
  const aborter = new AbortController();
  const stop = () => aborter.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    const response = await fetch(`${connection.url}/api/cli/tasks`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${connection.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ argv }),
      signal: aborter.signal,
      redirect: "error",
    });
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message ?? `Kouro task request failed: HTTP ${response.status}`);
    }
    if (!response.body) throw new Error("Kouro task response has no body");
    let pending = "";
    let exitCode: number | undefined;
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { value: chunk, done } = await reader.read();
        if (done) break;
        pending += decoder.decode(chunk, { stream: true });
        let newline: number;
        while ((newline = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (!line.trim()) continue; // Heartbeat while a provider is quiet.
          const value = JSON.parse(line);
          if (value.event === "task.finished") exitCode = value.exitCode;
          else if (value.event === "task.error") throw new Error(value.message);
          else write(value);
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (!Number.isInteger(exitCode))
      throw new Error("Kouro task connection ended before its result");
    return exitCode!;
  } catch (cause) {
    if (aborter.signal.aborted) return 130;
    throw cause;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
