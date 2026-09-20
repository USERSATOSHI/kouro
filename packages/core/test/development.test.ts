import { describe, expect, test } from "bun:test";
import {
  WorkflowBuilder,
  compareWorkflowVersions,
  compileWorkflow,
  renderPromptFixture,
  validateSchemaFixture,
} from "@kouro/core";

describe("M8.1 development tools", () => {
  test("validates fixture paths without compiling or executing a workflow", () => {
    expect(validateSchemaFixture({ type: "object", required: ["name"] }, { name: "Ada" })).toEqual({
      valid: true,
    });
    const invalid = validateSchemaFixture({ type: "object", required: ["name"] }, {});
    expect(invalid.valid).toBe(false);
    if (!invalid.valid) expect(invalid.errors.join(" ")).toContain("required");
  });

  test("renders a prompt fixture and keeps an exact content digest", async () => {
    const first = await renderPromptFixture({
      id: "greeting",
      template: "Hello {{name}}",
      variablesSchema: { type: "object", required: ["name"] },
      variables: { name: "Ada" },
    });
    const second = await renderPromptFixture({
      id: "greeting",
      template: "Hello {{name}}",
      variablesSchema: { type: "object", required: ["name"] },
      variables: { name: "Grace" },
    });
    expect(first.rendered).toBe("Hello Ada");
    expect(first.digest).toBe(second.digest);
    expect(
      await renderPromptFixture({
        id: "missing",
        template: "Hello {{person.name}}",
        variablesSchema: { type: "object" },
        variables: {},
      }),
    ).toMatchObject({ valid: false, errors: ["Missing prompt variable: person.name"] });
  });

  test("reports affected source nodes between compiled versions", async () => {
    const left = new WorkflowBuilder({ id: "compare" });
    const done = left.complete("done");
    left.startAt(done);
    const right = new WorkflowBuilder({ id: "compare" });
    const changed = right.agent("agent", { prompt: "changed" });
    const done2 = right.complete("done");
    right.sequence(changed, done2);
    right.startAt(changed);
    const comparison = await compareWorkflowVersions(
      await compileWorkflow(left.build()),
      await compileWorkflow(right.build()),
    );
    expect(comparison.equal).toBe(false);
    expect(comparison.affectedNodes.length).toBeGreaterThan(0);
  });
});
