import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationService } from "../src/application/service.ts";

describe("M8 prompt fixture execution", () => {
  test("runs the rendered prompt through the ordinary coordinator and journal", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kouro-m8-prompt-"));
    const service = new ApplicationService({ dataDir, scriptedDelayMs: 1 });
    await service.start();
    const fixture = {
      id: "greeting",
      template: "Say hello to {{name}}",
      variablesSchema: { type: "object", required: ["name"] },
      variables: { name: "Ada" },
    };
    const run = await service.runPromptFixture({ fixture, idempotencyKey: "prompt:greeting" });
    let view = service.getView(run.runId)!;
    for (let index = 0; index < 100 && view.state.status !== "succeeded"; index += 1) {
      await Bun.sleep(5);
      view = service.getView(run.runId)!;
    }
    expect(view.state.status).toBe("succeeded");
    expect(Object.values(view.state.attempts)).toHaveLength(1);
    expect(
      service.getEvents(run.runId, 0).some((event) => event.type === "attempt.completed"),
    ).toBe(true);
    expect(service.coordinator.journal.getRunInput(run.runId)?.__kouroPromptFixture).toMatchObject({
      id: "greeting",
    });
    const again = await service.runPromptFixture({ fixture, idempotencyKey: "prompt:greeting" });
    expect(again.runId).toBe(run.runId);
    await expect(
      service.runPromptFixture({
        fixture: { ...fixture, template: "A different {{name}} prompt" },
        idempotencyKey: "prompt:greeting",
      }),
    ).rejects.toThrow(/idempotency key payload conflict/);
    await service.close();
  });
});
