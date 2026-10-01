import { expect, test } from "bun:test";
import { WorkflowBuilder, artifactType, compileWorkflow } from "@kouro/core";
import { launchInputs } from "./WorkflowInputs";

test("typed launch inputs preserve false and zero, validate objects, and omit optional defaults", async () => {
  const builder = new WorkflowBuilder({ id: "typed-launch" });
  builder.input("enabled", artifactType("flag", { type: "boolean" }));
  builder.input("count", artifactType("count", { type: "integer", minimum: 0 }));
  builder.input(
    "settings",
    artifactType("settings", {
      type: "object",
      required: ["label"],
      properties: { label: { type: "string", minLength: 1 } },
    }),
  );
  builder.input("optional", artifactType("optional", { type: "string" }), { required: false });
  const done = builder.complete("done");
  builder.startAt(done);
  const bundle = await compileWorkflow(builder.build());
  expect(launchInputs(bundle, "", {}).valid).toBe(false);
  expect(
    launchInputs(bundle, "", { enabled: "false", count: "0", settings: '{"label":"ready"}' }),
  ).toEqual({
    input: { enabled: false, count: 0, settings: { label: "ready" } },
    errors: {},
    valid: true,
  });
  expect(
    launchInputs(bundle, "", { enabled: "false", count: "1.5", settings: "{}" }).errors,
  ).toHaveProperty("count");
  expect(launchInputs(bundle, "", { enabled: "false", count: "0", settings: "{" }).valid).toBe(
    false,
  );
});
