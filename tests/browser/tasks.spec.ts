import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
import { execFile } from "node:child_process";

test("a task launched by the actual CLI appears in an already open dashboard", async ({ page }) => {
  await page.goto("/#token=kouro-browser-test-token");
  await expect(page.getByRole("button", { name: "Workflow task", exact: true })).toBeVisible();
  const host = await page.request.get("/api/cli/host", {
    headers: { authorization: "Bearer kouro-browser-test-token" },
  });
  expect(host.ok()).toBe(true);
  const { workspace } = await host.json();
  const cliEnvironment = { ...process.env };
  delete cliEnvironment.FORCE_COLOR;
  const { output, error, code } = await new Promise<{
    output: string;
    error: string;
    code: number;
  }>((done) =>
    execFile(
      "bun",
      [
        resolve("packages/host/src/cli.ts"),
        "task",
        "run",
        "--task",
        "CLI dashboard visibility marker",
        "--workflow",
        "task-gated",
        "--harness",
        "codex",
        "--model",
        "fixture",
        "--workspace",
        workspace,
        "--data-dir",
        workspace,
      ],
      { timeout: 15000, env: cliEnvironment },
      (failure, output, error) =>
        done({
          output,
          error,
          code: typeof failure?.code === "number" ? failure.code : failure ? 1 : 0,
        }),
    ),
  );
  expect(error).toBe("");
  expect(code).toBe(3);
  const report = JSON.parse(output.trim().split("\n").at(-1)!);
  expect(report.waitingForApproval).toBe(true);
  const row = page.getByRole("button", { name: /CLI dashboard visibility marke/ });
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.getByTestId("run-status")).toHaveText("running");
  await page.getByRole("tab", { name: "Milestones", exact: true }).click();
  await expect(page.getByText("Build A", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Waiting for approval", { exact: true })).toHaveCount(2);
  await page.reload();
  await expect(page.getByTestId("run-status")).toHaveText("running");
  const view = await (await page.request.get(`/api/runs/${report.runId}/view`)).json();
  expect(view.bundle.rootDefinitionId).toBe("automatic-task");
});

test("an older backend's HTML response shows how to restart instead of a JSON parse error", async ({
  page,
}) => {
  await page.route("**/api/task-workflows", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>Kouro</title>",
    }),
  );
  await page.goto("/#token=kouro-browser-test-token");
  await page.getByRole("button", { name: "Workflow task", exact: true }).click();
  const error = page.getByRole("alert");
  await expect(error).toContainText("/api/task-workflows returned text/html instead of JSON");
  await expect(error).toContainText("bun run dev");
  await expect(error).not.toContainText("SyntaxError");
});

async function launch(page: import("@playwright/test").Page, gated = false) {
  await page.goto("/#token=kouro-browser-test-token");
  await page.getByRole("button", { name: "Workflow task", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Workflow task", exact: true })).toBeVisible();
  const choices = page.getByRole("group", { name: "Available workflows" }).getByRole("checkbox");
  await expect(choices.first()).toBeVisible();
  for (const checkbox of await choices.all())
    if (await checkbox.isChecked()) await checkbox.uncheck();
  await page
    .getByRole("checkbox", { name: gated ? /Approval task fixture/ : /Automatic task fixture/ })
    .check();
  await page.getByRole("textbox", { name: "Planning model", exact: true }).fill("fixture-planner");
  await page
    .getByRole("textbox", { name: "Execution model", exact: true })
    .fill("fixture-executor");
  await page
    .getByRole("textbox", { name: "Task", exact: true })
    .fill("Build two components and combine their results");
  const response = page.waitForResponse(
    (response) => response.url().endsWith("/api/tasks") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Start workflow task", exact: true }).click();
  const created = await response;
  expect(created.ok()).toBe(true);
  const run = await created.json();
  await expect(page.getByRole("heading", { name: "Milestones", exact: true })).toBeVisible();
  return run.id as string;
}

test("one task generates assigned milestones, executes dependencies and retains results after reload", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const runId = await launch(page);
  await expect(page.getByTestId("run-status")).toHaveText("succeeded");
  await expect(page.getByText("Build A", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/After: a, b/)).toBeVisible();
  const progress = await (await page.request.get(`/api/runs/${runId}/milestones`)).json();
  expect(progress.milestones.map((item: { status: string }) => item.status)).toEqual([
    "succeeded",
    "succeeded",
    "succeeded",
  ]);
  await page.getByRole("button", { name: "Open milestone session", exact: true }).last().click();
  await expect(page.getByText(/Finished Combine A and B/).first()).toBeVisible();
  await page.reload();
  await page.getByRole("tab", { name: "Milestones", exact: true }).click();
  await expect(page.getByText(/After: a, b/)).toBeVisible();
  expect(errors).toEqual([]);
});

test("automatically selected workflows retain their approval gates", async ({ page }) => {
  const runId = await launch(page, true);
  await expect(page.getByText("Waiting for approval", { exact: true })).toHaveCount(2);
  await expect(page.getByText("waiting", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Review approval", exact: true }).first().click();
  await expect(page.getByTestId("approval-panel")).toBeVisible();
  await page.getByTestId("approve-run").click();
  await page.getByRole("tab", { name: "Milestones", exact: true }).click();
  await expect(page.getByRole("button", { name: "Review approval", exact: true })).toHaveCount(1);
  await page.reload();
  await page.getByRole("tab", { name: "Milestones", exact: true }).click();
  await expect(page.getByRole("button", { name: "Review approval", exact: true })).toHaveCount(1);
  const progress = await (await page.request.get(`/api/runs/${runId}/milestones`)).json();
  expect(progress.milestones.at(-1).status).toBe("waiting");
});
