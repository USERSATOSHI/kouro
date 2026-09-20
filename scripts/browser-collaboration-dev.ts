import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { ApplicationService } from "../packages/host/src/application/service.ts";
import { CollaborationGateway } from "../packages/host/src/collaboration/gateway.ts";
import { createHostServer } from "../packages/host/src/http/server.ts";

// Browser acceptance uses the same host and HTTP route as production. This
// launcher only adds durable collaboration rows to a dedicated temporary test
// data directory so the UI has real participants/messages to render.
const dataDir = resolve(process.env.KOURO_DATA_DIR ?? ".kouro-browser-data");
const service = new ApplicationService({ dataDir, scriptedDelayMs: 5_000 });
await service.start();
const run = await service.createRun({
  workflowId: "tiny",
  executionProfile: "scripted",
  idempotencyKey: `browser-collaboration-${randomUUID()}`,
  actor: "browser-fixture",
});

let attemptId: string | undefined;
for (let i = 0; i < 100 && !attemptId; i += 1) {
  const view = service.getView(run.runId);
  attemptId = Object.values(view?.state.attempts ?? {}).find((attempt) =>
    ["reserved", "running", "waiting"].includes(attempt.status),
  )?.id;
  if (!attemptId) await Bun.sleep(50);
}
if (!attemptId) throw new Error("browser collaboration fixture did not reserve an attempt");

const gateway = new CollaborationGateway(service.coordinator.journal);
gateway.configureParticipant(run.runId, "planner");
gateway.configureParticipant(run.runId, "reviewer");
gateway.configureChannel(run.runId, {
  name: "blackboard:findings",
  participants: ["planner", "reviewer"],
});
const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
const planner = gateway.issueGrant({
  runId: run.runId,
  attemptId,
  participantId: "planner",
  expiresAt,
});
gateway.send(planner.grantId, {
  recipientParticipantId: "reviewer",
  body: "The scripted fixture found a durable handoff.",
  idempotencyKey: "browser-direct-message",
});
gateway.send(planner.grantId, {
  channel: "blackboard:findings",
  body: "Review the generated artifact before handoff.",
  idempotencyKey: "browser-blackboard-entry",
});

const host = createHostServer(service, {
  staticRoot: resolve("packages/web/dist"),
  token: process.env.KOURO_TOKEN,
  port: Number(process.env.KOURO_PORT ?? 43127),
});
host.start();
process.stdout.write(`Kouro browser fixture: http://127.0.0.1:${host.port}/#token=${host.token}\n`);

let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await host.stop();
  await service.close();
};
process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());
