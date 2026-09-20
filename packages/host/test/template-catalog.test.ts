import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { main } from "../src/cli.ts";
import { ApplicationService } from "../src/application/service.ts";
import { FakeProcessAdapter } from "../src/adapters/process/bwrap.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("workflow template catalog", () => {
  test("exposes sequential and fusion templates as runnable compiled bundles", async () => {
    const dataDir = mkdtempSync(join("/tmp", "kouro-template-"));
    directories.push(dataDir);
    const templateRoot = resolve(process.cwd(), ".kouro");
    const featurePath = resolve(templateRoot, "catalog-feature");
    const fusionPath = resolve(templateRoot, "catalog-fusion");
    rmSync(featurePath, { recursive: true, force: true });
    rmSync(fusionPath, { recursive: true, force: true });
    expect(await main(["create", "template", "catalog-feature", "--template", "feature"])).toBe(0);
    expect(
      await main(["create", "template", "catalog-fusion", "--template", "feature-fusion"]),
    ).toBe(0);
    directories.push(featurePath, fusionPath);
    const service = new ApplicationService({
      dataDir,
      templateRoot,
      process: new FakeProcessAdapter(),
      scriptedDelayMs: 1,
    });
    await service.start();
    const catalog = await service.workflows();
    const ids = catalog.map((entry) => entry.id);
    expect(ids).toEqual(["tiny", "feature", "parallel", "catalog-feature", "catalog-fusion"]);
    const fusion = catalog.find((entry) => entry.id === "catalog-fusion")!;
    expect(fusion.bundle.definitions[fusion.bundle.rootDefinitionId].nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "planners", kind: "fork" }),
        expect.objectContaining({ id: "planner-a", kind: "agent", modelId: "model-a" }),
        expect.objectContaining({ id: "planner-b", kind: "agent", modelId: "model-b" }),
        expect.objectContaining({ id: "fusion", kind: "agent", modelId: "model-fusion" }),
        expect.objectContaining({ id: "join-planners", kind: "join" }),
      ]),
    );
    await service.close();
  });
});
