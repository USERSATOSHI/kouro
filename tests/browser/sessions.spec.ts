import { expect, test, type Page } from "@playwright/test";

test("typed launch inputs and separate parent and child models reach the pinned run bundle", async ({ page }) => {
  await page.goto("/#token=kouro-browser-test-token");
  await page.getByRole("button", { name: /Typed launch and child settings/ }).click();
  await expect(page.getByTestId("start-run").first()).toBeDisabled();
  const parent = page.getByRole("group", { name: "browser-configured / parent · agent", exact: true });
  const first = page.getByRole("group", { name: /first.*read-only subagent/ });
  const second = page.getByRole("group", { name: /second.*read-only subagent/ });
  await parent.getByLabel("Model", { exact: true }).fill("parent-model");
  await first.getByLabel("Model", { exact: true }).fill("first-model");
  await second.getByLabel("Model", { exact: true }).fill("second-model");
  await expect(first.getByLabel("Repository write", { exact: true })).toBeDisabled();
  await page.getByLabel("enabled", { exact: true }).selectOption("false");
  await page.getByLabel("count", { exact: true }).fill("1.5");
  await page.getByLabel("settings.label", { exact: true }).fill("ready");
  await expect(page.getByTestId("start-run").first()).toBeDisabled();
  await page.getByLabel("count", { exact: true }).fill("0");
  await expect(page.getByTestId("start-run").first()).toBeEnabled();
  const createdResponse = page.waitForResponse((response) => response.url().endsWith("/api/runs") && response.request().method() === "POST");
  await page.getByTestId("start-run").first().click();
  const created = await createdResponse;
  expect(created.ok()).toBe(true);
  expect(created.request().postDataJSON().input).toEqual({ enabled: false, count: 0, settings: { label: "ready" } });
  const run = await created.json();
  await expect(page.getByTestId("run-status")).toHaveText("succeeded");
  const view = await (await page.request.get(`/api/runs/${run.id}/view`)).json();
  const definitions = view.bundle.definitions;
  const root = definitions[view.bundle.rootDefinitionId];
  expect(root.nodes.find((node: { id: string }) => node.id === "parent").modelId).toBe("parent-model");
  for (const [id, model] of [["first", "first-model"], ["second", "second-model"]]) {
    const childId = root.scouts.find((scout: { id: string }) => scout.id === id).definitionId;
    expect(definitions[childId].nodes.find((node: { kind: string }) => node.kind === "agent").modelId).toBe(model);
  }
});

async function openFixture(page: Page, workflowId: string) {
  await page.goto("/#token=kouro-browser-test-token");
  const runId = await page.evaluate(async (workflowId) => {
    // Wait for the app's pairing request to complete before reading the catalog.
    for (let tries = 0; tries < 50; tries++) {
      const response = await fetch("/api/runs");
      if (response.ok) {
        const runs = (await response.json()) as Array<{ id: string; workflowId: string }>;
        const run = runs.find((item) => item.workflowId === workflowId);
        if (run) return run.id;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Fixture ${workflowId} missing`);
  }, workflowId);
  await page.goto(`/?run=${encodeURIComponent(runId)}`);
  await expect(page.getByTestId("workflow-graph")).toBeVisible();
  return runId;
}

test("interrupting the selected agent permits a drained retry without cancelling the run", async ({ page }) => {
  await openFixture(page, "web-session-interrupt");
  await page.getByRole("button", { name: "Agent session", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "web-session-interrupt" });
  await expect(dialog).toContainText("waiting for operator interrupt");
  await dialog.getByRole("button", { name: "Interrupt agent", exact: true }).click();
  await expect(page.getByTestId("run-status")).toHaveText("failed");
  await expect(dialog).toContainText("Agent interrupt requested");
  await dialog.getByLabel("Close agent session").click();
  await page.getByRole("button", { name: "Retry invocation", exact: true }).click();
  await expect(page.getByTestId("run-status")).toHaveText("succeeded");
  await page.reload(); await expect(page.getByTestId("run-status")).toHaveText("succeeded");
});

test("real parent and subagent sessions retain tool results, steer, reconnect, and replay", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const runId = await openFixture(page, "web-session-live");
  await page.getByRole("button", { name: "Agent session", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "web-session-parent" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Parent session marker");
  await expect(dialog).toContainText("Child session marker");
  await expect(dialog.locator(".session-tool")).toHaveCount(2);
  await expect(dialog).toContainText("Parent tool result");
  await expect(dialog.getByTestId("session-split")).toBeVisible();
  await expect(dialog.getByRole("region", { name: "Main model session" })).toContainText(
    "Parent session marker",
  );
  await expect(dialog.getByRole("region", { name: "Subagent model session" })).toContainText(
    "Child tool result",
  );
  await dialog.getByRole("button", { name: "Combined view" }).click();
  await dialog.getByLabel("Session speaker").selectOption("reviewer");
  await expect(dialog).toContainText("Child session marker");
  await expect(dialog).not.toContainText("Parent session marker");
  await expect(dialog).toContainText("Reviewing the fixture");
  await dialog.getByLabel("Session speaker").selectOption("all");
  await dialog.getByLabel("Steer active agent").fill("web-steer-marker");
  await dialog.getByLabel("Steer active agent").press("Enter");
  await expect(dialog).toContainText("Instruction received: web-steer-marker");
  await expect(dialog.getByLabel("Steer active agent")).toHaveValue("");
  await dialog.getByLabel("Close agent session").click();
  await page.getByRole("button", { name: "tools", exact: true }).click();
  await expect(page.locator(".inspector .session-tool")).toHaveCount(2);
  await expect(page.locator(".inspector")).toContainText("Child tool result");
  await expect(page.locator(".inspector")).toContainText("Parent tool result");
  await expect(
    page.locator(".inspector .activity-fields dt").filter({ hasText: "stdout" }),
  ).toBeVisible();
  await expect(
    page.locator(".inspector .activity-text").filter({ hasText: "Parent tool result" }),
  ).toHaveText("Parent tool result");
  await page.getByRole("button", { name: "logs", exact: true }).click();
  await expect(page.locator(".log-results")).toContainText("Reviewing the fixture");

  // Reload must preserve the selected run and journal-backed activity.
  await page.reload();
  await expect(page.getByTestId("workflow-graph")).toBeVisible();
  expect(new URL(page.url()).searchParams.get("run")).toBe(runId);
  await page.getByRole("button", { name: "Agent session", exact: true }).click();
  await expect(dialog).toContainText("Instruction received: web-steer-marker");
  await expect(dialog.locator(".session-tool")).toHaveCount(2);
  await dialog.getByLabel("Steer active agent").fill("spawn-live-subagent");
  await dialog.getByRole("button", { name: "Send instruction" }).click();
  await expect(dialog.getByRole("region", { name: "Subagent model session" })).toContainText(
    "Live child is inspecting the fixture",
  );
  await expect(dialog.getByLabel("Live subagent")).toContainText("browser-live-review");
  await expect(dialog.getByRole("region", { name: "Subagent model session" })).toContainText(
    "Child tool result",
  );
  await dialog.getByLabel("Steer active agent").fill("finish-session");
  await dialog.getByRole("button", { name: "Send instruction" }).click();
  await expect(page.getByTestId("run-status")).toHaveText("succeeded");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Parent session marker");
  await dialog.getByLabel("Close agent session").click();
  await page.reload();
  await page.getByRole("button", { name: "Agent session", exact: true }).click();
  await expect(dialog).toContainText("Child session marker");
  await expect(dialog.locator(".session-tool")).toHaveCount(2);
  expect(errors).toEqual([]);
  await page.screenshot({ path: "test-results/session-desktop.png", fullPage: true });
});

test("failed invocation recovery starts one attempt and shows its typed output", async ({
  page,
}) => {
  await openFixture(page, "web-session-failure");
  await expect(page.getByTestId("run-status")).toHaveText("failed");
  await page.getByRole("button", { name: "Retry invocation", exact: true }).click();
  await expect(page.getByTestId("run-status")).toHaveText("succeeded");
  await page.getByLabel("Inspect invocation").selectOption({ label: "parent · succeeded · #1" });
  await expect(page.locator(".artifact-preview")).toContainText("Recovered browser session");
  await page.getByRole("button", { name: "attempts", exact: true }).click();
  await expect(page.locator(".attempt-card")).toHaveCount(3);
});

test("390px session supports history retry, keyboard focus, and visible cancellation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openFixture(page, "web-session-cancel");
  let failHistory = true;
  await page.route("**/api/runs/*/activity?**", async (route) => {
    if (failHistory) {
      failHistory = false;
      return route.fulfill({ status: 503, json: { message: "Temporary history failure" } });
    }
    await route.continue();
  });
  await page.getByRole("button", { name: "Agent session", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "web-session-parent" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Temporary history failure");
  await dialog.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(dialog).not.toContainText("Temporary history failure");
  await expect(dialog.getByRole("button", { name: "Cancel run" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await dialog.getByRole("button", { name: "Cancel run" }).click();
  await expect(page.getByTestId("run-status")).toHaveText("cancelled");
  await page.screenshot({ path: "test-results/session-390.png", fullPage: true });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Agent session", exact: true })).toBeFocused();
});

test("re-pairing, snapshot retry, and a late failure cannot replace the newly selected run", async ({
  page,
}) => {
  await page.setViewportSize({ width: 768, height: 900 });
  const runId = await openFixture(page, "web-session-live");
  await page.context().clearCookies();
  await page.reload();
  await expect(page.getByTestId("workflow-graph")).toBeVisible();
  expect(new URL(page.url()).searchParams.get("run")).toBe(runId);
  let fail = true;
  await page.route(`**/api/runs/${runId}/view`, async (route) => {
    if (fail) {
      fail = false;
      return route.fulfill({ status: 503, json: { message: "Temporary snapshot failure" } });
    }
    await route.continue();
  });
  await page.reload();
  await expect(page.getByText("Temporary snapshot failure", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect(page.getByTestId("workflow-graph")).toBeVisible();
  await page.unroute(`**/api/runs/${runId}/view`);
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let intercepted = false;
  await page.route(`**/api/runs/${runId}/view`, async (route) => {
    intercepted = true;
    await pending;
    await route.fulfill({ status: 503, json: { message: "Old run failure" } });
  });
  await page.reload();
  await expect.poll(() => intercepted).toBe(true);
  const nextId = await page.evaluate(async () => {
    const runs = (await (await fetch("/api/runs")).json()) as Array<{
      id: string;
      workflowId: string;
    }>;
    return runs.find((run) => run.workflowId === "web-session-failure")!.id;
  });
  await page.getByLabel("Selected run").selectOption(nextId);
  await expect(page.getByTestId("workflow-graph")).toBeVisible();
  release!();
  await expect(page.locator(".topbar .run-id")).toHaveText(nextId);
  await expect(page.locator(".stream-state")).toHaveText("LIVE");
  await expect(page.getByText("Old run failure", { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".topbar .run-id")).toHaveText(nextId);
});

test("required task gates both launch controls", async ({ page }) => {
  await page.goto("/#token=kouro-browser-test-token");
  await page.getByRole("button", { name: /Chore/ }).click();
  await expect(page.getByTestId("start-run").first()).toBeDisabled();
  await expect(page.locator(".preview .primary-cta")).toBeDisabled();
  const task = page.getByPlaceholder("Describe what this workflow should accomplish…");
  await task.fill("A concrete feature task");
  await expect(page.getByTestId("start-run").first()).toBeEnabled();
  await expect(page.locator(".preview .primary-cta")).toBeEnabled();
  await task.fill("   ");
  await expect(page.getByTestId("start-run").first()).toBeDisabled();
});

test("session search exposes matches beyond the rendered window without raw tool JSON", async ({
  page,
}) => {
  await openFixture(page, "web-session-failure");
  await page.route("**/api/runs/*/activity?**", async (route) => {
    const attemptId = new URL(route.request().url()).searchParams.get("attemptId")!;
    const items = Array.from({ length: 300 }, (_, index) => ({
      attemptId,
      cursor: index + 10000,
      event: {
        type: "tool",
        data: {
          id: `archive-${index}`,
          name: "Read",
          status: "completed",
          input: { path: `archive-marker-${index}.ts` },
          output: { stdout: `archive output ${index}`, exitCode: 0 },
        },
      },
    }));
    await route.fulfill({ json: { items, nextCursor: 10300, hasMore: false } });
  });
  await page.getByRole("button", { name: "Agent session", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Search agent session").fill("archive-marker");
  await expect(dialog).toContainText("300 matches");
  await expect(dialog.locator(".session-tool")).toHaveCount(250);
  await expect(dialog).toContainText("archive-marker-0.ts");
  await dialog.getByRole("button", { name: "Newer messages" }).click();
  await expect(dialog).toContainText("archive-marker-299.ts");
  await expect(
    dialog.locator(".activity-text").filter({ hasText: "archive output 299" }),
  ).toHaveText("archive output 299");
});

test("journal history outlives the 4000-observation tail and full tool outputs remain downloadable", async ({ page }) => {
  const runId = await openFixture(page, "web-session-large");
  await expect(page.getByTestId("run-status")).toHaveText("succeeded");
  await page.getByRole("button", { name: "Agent session", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const full = dialog.getByRole("link", { name: /Download full output/ });
  await expect(full).toBeVisible();
  await expect(dialog.locator(".activity-fields dt").filter({ hasText: "stdout" })).toBeVisible();
  const response = await page.request.get((await full.getAttribute("href"))!);
  expect(response.ok()).toBe(true);
  expect((await response.json()).stdout).toContain("FULL_OUTPUT_END_MARKER");
  await dialog.getByLabel("Search agent session").fill("Durable history marker 0");
  await expect(dialog).toContainText("Durable history marker 0");
  const count = await page.evaluate(async (runId) => {
    let after = 0; let count = 0;
    for (;;) {
      const page = await (await fetch(`/api/runs/${runId}/activity?after=${after}&limit=500`)).json();
      count += page.items.length;
      if (!page.hasMore) return count;
      after = page.nextCursor;
    }
  }, runId);
  expect(count).toBeGreaterThan(4000);
  await page.reload(); await page.getByRole("button", { name: "Agent session", exact: true }).click();
  await expect(full).toBeVisible();
});
