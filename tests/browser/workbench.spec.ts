import { expect, test } from "@playwright/test";
import { cwd } from "node:process";

test("real host runs the compiled graph and grows live timeline bars", async ({ page }) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.goto("/#token=kouro-browser-test-token");
  await expect(page.getByTestId("start-run").first()).toBeEnabled();
  await expect(page.getByLabel("Execution profile")).toHaveValue("scripted");
  await expect(
    page.getByLabel("Execution profile").locator('option[value="codex-readonly"]'),
  ).toHaveCount(1);
  await page.getByTestId("start-run").first().click();
  await expect(page.getByTestId("workflow-graph")).toBeVisible();
  await expect(page.getByTestId("execution-timeline")).toBeVisible();
  await expect(page.getByTestId("run-status")).toHaveText("running");

  const canvas = page.getByTestId("timeline-canvas");
  const fittedWidth = await canvas.evaluate((element) => element.getBoundingClientRect().width);
  await page.getByTestId("timeline-zoom-in").click();
  await expect.poll(() => canvas.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(fittedWidth);
  await page.getByTestId("timeline-fit").click();

  const bar = page.locator('[data-testid="timeline-bar"][data-active="true"]').first();
  await expect(bar).toBeVisible();
  const invocationId = await bar.getAttribute("data-invocation-id");
  expect(invocationId).toBeTruthy();
  const initialElapsed = Number(await bar.getAttribute("data-duration-ms"));
  expect(Number.isFinite(initialElapsed)).toBe(true);
  await expect.poll(async () => Number(await bar.getAttribute("data-duration-ms")), { timeout: 3000 })
    .toBeGreaterThan(initialElapsed + 500);
  await bar.click();
  await expect(page.getByTestId("node-inspector")).toHaveAttribute("data-invocation-id", invocationId!);
  await expect(page.getByTestId("run-status")).toHaveText("succeeded", { timeout: 20_000 });
  await page.screenshot({ path: "test-results/m1-workbench-desktop.png", fullPage: true });

  await page.reload();
  await expect(page.getByTestId("run-status")).toHaveText("succeeded");
  await expect(page.locator('[data-testid="timeline-bar"][data-active="true"]')).toHaveCount(0);
  expect(browserErrors).toEqual([]);
});

test("small viewport keeps the workbench readable", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 900 });
  await page.goto("/#token=kouro-browser-test-token");
  await expect(page.getByTestId("start-run").first()).toBeEnabled();
  await page.screenshot({ path: "test-results/m1-workbench-small.png", fullPage: true });
  const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  expect(horizontalOverflow).toBe(false);
});

test("quiet SSE stays live and a returning tab refreshes its run snapshot", async ({ page }) => {
  await page.goto("/#token=kouro-browser-test-token");
  await page.getByTestId("start-run").first().click();
  await expect(page.getByTestId("run-status")).toHaveText("succeeded", { timeout: 20_000 });
  await expect(page.locator(".stream-state")).toHaveText("LIVE");
  // There are no more lifecycle frames after completion. Heartbeats must keep
  // Bun's idle timeout from disconnecting this long-lived trace subscription.
  await page.waitForTimeout(11_000);
  await expect(page.locator(".stream-state")).toHaveText("LIVE");
  const refreshed = page.waitForResponse((response) =>
    response.url().includes("/api/runs/") && response.url().endsWith("/view"),
  );
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await refreshed;
  await expect(page.locator(".stream-state")).toHaveText("LIVE");
  await expect(page.getByTestId("run-status")).toHaveText("succeeded");
});

test("live timeline uses host time under client skew and honors reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    const original = Date.now;
    Date.now = () => original() + 3_600_000;
  });
  await page.goto("/#token=kouro-browser-test-token");
  await page.getByTestId("start-run").first().click();
  const bar = page.locator('[data-testid="timeline-bar"][data-active="true"]').first();
  await expect(bar).toBeVisible();
  const duration = Number(await bar.getAttribute("data-duration-ms"));
  expect(duration).toBeLessThan(10_000);
  const transitionSeconds = await bar.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).transitionDuration),
  );
  expect(transitionSeconds).toBeLessThan(0.01);
  await expect(page.getByTestId("run-status")).toHaveText("succeeded", { timeout: 20_000 });
});

test("feature workflow durably waits for approval and reaches terminal state", async ({ page }) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.goto("/#token=kouro-browser-test-token");
  await expect(page.getByRole("button", { name: /Feature development loop/ })).toBeVisible();
  await page.getByRole("button", { name: /Feature development loop/ }).click();
  await expect(page.getByTestId("start-run").first()).toBeEnabled();
  await page.getByTestId("start-run").first().click();
  await expect(page.getByTestId("workflow-graph")).toBeVisible();

  // The approval is a journal-backed pending invocation, not a client-side modal.
  await expect(page.getByTestId("approval-panel")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("approve-run")).toBeEnabled();
  await expect(page.getByTestId("run-status")).toHaveText("running");
  // React Flow virtualizes edge labels outside the current viewport. Assert
  // the authoritative compiled graph routes, while the live graph stays visible.
  const featureEdges = await page.evaluate(async () => {
    const workflows = (await (await fetch("/api/workflows")).json()) as Array<{
      id: string;
      graph: { edges: Array<{ label?: string }> };
    }>;
    return workflows.find((workflow) => workflow.id === "feature")?.graph.edges.map((edge) => edge.label) ?? [];
  });
  expect(featureEdges).toContain("failure · repair");
  expect(featureEdges).toContain("failure · exhausted");

  await page.getByTestId("approve-run").click();
  await expect(page.getByRole("status")).toContainText("approve requested", { timeout: 5_000 });
  await expect(page.getByTestId("run-status")).toHaveText("succeeded", { timeout: 25_000 });
  await expect(page.getByTestId("approve-run")).toHaveCount(0);

  // A run without a repository must say so explicitly in the diff inspector.
  await page.getByRole("button", { name: "diff" }).click();
  await expect(page.getByTestId("diff-no-workspace")).toHaveText(
    "No repository workspace is attached to this run.",
  );
  expect(browserErrors).toEqual([]);
  await page.screenshot({ path: "test-results/m3-feature-approval-desktop.png", fullPage: true });
});

test("a workflow can return to its input form and start a second run", async ({ page }) => {
  await page.goto("/#token=kouro-browser-test-token");
  await page.getByRole("button", { name: /Feature development loop/ }).click();
  const taskInput = page.getByPlaceholder("Describe what this workflow should accomplish…");
  await expect(taskInput).toBeVisible();
  await taskInput.fill("First feature task");
  await page.locator(".preview .primary-cta").click();
  await expect(page.getByTestId("workflow-graph")).toBeVisible();
  const firstRunId = await page.locator(".topbar .run-id").textContent();
  expect(firstRunId).toBeTruthy();

  await page.getByRole("button", { name: /Feature development loop/ }).click();
  await expect(taskInput).toBeVisible();
  await expect(taskInput).toHaveValue("");
  await taskInput.fill("Second feature task");
  await page.locator(".preview .primary-cta").click();
  await expect(page.getByTestId("workflow-graph")).toBeVisible();
  const secondRunId = await page.locator(".topbar .run-id").textContent();
  expect(secondRunId).toBeTruthy();
  expect(secondRunId).not.toBe(firstRunId);
  await expect(page.locator(".run-list")).toContainText("First feature task");
  await expect(page.locator(".run-list")).toContainText("Second feature task");

  await page.getByRole("button", { name: "New run with different input" }).click();
  await expect(taskInput).toBeVisible();
  await expect(taskInput).toHaveValue("");
  await page.locator(".run-list .run-row").filter({ hasText: "First feature task" }).click();
  await expect(page.getByTestId("workflow-graph")).toBeVisible();
  await expect(page.locator(".topbar .run-id")).toHaveText(firstRunId!);
});

test("repository workspace diff is rendered from the host snapshot", async ({ page }) => {
  await page.goto("/#token=kouro-browser-test-token");
  await expect(page.getByTestId("start-run").first()).toBeEnabled();
  const runId = await page.evaluate(async (repositoryPath) => {
    const session = (await (await fetch("/api/session")).json()) as { csrfToken: string };
    const response = await fetch("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken },
      body: JSON.stringify({
        workflowId: "tiny",
        executionProfile: "scripted",
        workspace: { repositoryPath, workspaceId: "browser-fixture" },
        idempotencyKey: crypto.randomUUID(),
      }),
    });
    if (!response.ok) throw new Error(await response.text());
    return ((await response.json()) as { id: string }).id;
  }, cwd());
  await page.reload();
  await expect(page.getByTestId("run-status")).toHaveText("succeeded", { timeout: 20_000 });
  await page.locator(".work-node").first().click();
  await page.getByRole("button", { name: "diff" }).click();
  await expect(page.getByTestId("diff-summary")).toContainText("No changed paths", { timeout: 5_000 });
  expect(runId).toBeTruthy();
});

test("nested parallel fixture keeps graph, timeline, and scope state linked", async ({ page }) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.goto("/#token=kouro-browser-test-token");
  await expect(page.getByRole("button", { name: /Nested parallel fixture/ })).toBeVisible();
  await page.getByRole("button", { name: /Nested parallel fixture/ }).click();
  await page.getByTestId("start-run").first().click();
  await expect(page.getByTestId("workflow-graph")).toBeVisible();
  await expect(page.getByTestId("run-status")).toHaveText("running", { timeout: 10_000 });

  // Two child scopes are visible while both call branches are executing.
  await expect(page.locator(".scope-node")).toHaveCount(3, { timeout: 10_000 });
  const childScopes = page.locator('.scope-node').filter({ hasText: "parallel-child" });
  await expect(childScopes).toHaveCount(2);
  const workNodes = page.locator(".work-node");
  await expect(workNodes.filter({ hasText: "work" })).toHaveCount(2);

  // Collapse one concrete scope. Its descendant disappears, while the sibling remains.
  const firstScopeId = await childScopes.first().getAttribute("data-testid");
  expect(firstScopeId).toBeTruthy();
  const firstScope = page.getByTestId(firstScopeId!);
  await firstScope.locator(".scope-toggle").evaluate((element) => (element as HTMLButtonElement).click());
  await expect(firstScope.locator(".scope-toggle")).toHaveAttribute("data-collapsed", "true");
  await expect(page.locator(".work-node").filter({ hasText: "work" })).toHaveCount(1);
  await firstScope.locator(".scope-toggle").evaluate((element) => (element as HTMLButtonElement).click());
  await expect(page.locator(".work-node").filter({ hasText: "work" })).toHaveCount(2);

  // Select a nested invocation and retain its breadcrumb/identity across the graph.
  await page.locator(".work-node").filter({ hasText: "work" }).first().click();
  const selected = page.getByTestId("node-inspector");
  const selectedId = await selected.getAttribute("data-invocation-id");
  expect(selectedId).toBeTruthy();
  await expect(page.getByTestId("graph-breadcrumb")).toContainText("parallel-child");

  // Both branches are concurrent and remain distinct by invocation identity.
  const bars = page.locator('[data-testid="timeline-bar"][data-source-node-id="work"]');
  await expect(bars).toHaveCount(2, { timeout: 10_000 });
  const ids = await bars.evaluateAll((items) => items.map((item) => item.getAttribute("data-invocation-id")));
  expect(new Set(ids).size).toBe(2);
  expect(await bars.evaluateAll((items) => items.every((item) => Number(item.getAttribute("data-duration-ms")) > 1_000))).toBe(true);
  const firstBar = bars.first();
  const firstBarId = await firstBar.getAttribute("data-invocation-id");

  // Timeline selection points at the same invocation shown by the inspector.
  await firstBar.click();
  await expect(selected).toHaveAttribute("data-invocation-id", firstBarId!);
  await expect(page.getByTestId("run-status")).toHaveText("succeeded", { timeout: 20_000 });

  // Activation order is durable: completion does not reshuffle timeline rows.
  const rowIds = await page.locator('[data-testid="timeline-bar"]').evaluateAll((items) =>
    items.map((item) => item.getAttribute("data-invocation-id")),
  );
  expect(new Set(rowIds).size).toBeGreaterThanOrEqual(2);
  expect(browserErrors).toEqual([]);
  await page.screenshot({ path: "test-results/m4-nested-parallel-desktop.png", fullPage: true });
});

test("nested parallel workbench remains usable at 768px", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 900 });
  await page.goto("/#token=kouro-browser-test-token");
  // The compact responsive header uses the same authoritative workflow
  // catalog through a select rather than the desktop launch cards.
  await page.getByRole("combobox", { name: "Workflow" }).selectOption("parallel");
  await page.getByTestId("start-run").first().click();
  await expect(page.getByTestId("workflow-graph")).toBeVisible();
  await expect(page.getByTestId("execution-timeline")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: "test-results/m4-nested-parallel-768.png", fullPage: true });
});
