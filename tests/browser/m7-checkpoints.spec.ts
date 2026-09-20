import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const token = "kouro-browser-test-token";
const repositoryPath = mkdtempSync(join(tmpdir(), "kouro-m7-browser-repo-"));
execFileSync("git", ["init", "--initial-branch=main"], { cwd: repositoryPath });
writeFileSync(join(repositoryPath, "README.md"), "M7 browser fixture\n");
execFileSync("git", ["add", "."], { cwd: repositoryPath });
execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"], { cwd: repositoryPath });
test.afterAll(() => rmSync(repositoryPath, { recursive: true, force: true }));

test("M7 refuses an active cut, then captures and exposes fork genealogy", async ({ page }) => {
  await page.goto(`/#token=${token}`);
  await expect(page.getByTestId("start-run").first()).toBeEnabled();

  // A checkpoint requires a Git-backed run. The ordinary tiny UI launch has no
  // workspace, so create a real repository-backed feature run through the API.
  const runId = await page.evaluate(async (repositoryPath) => {
    const session = await (await fetch("/api/session")).json() as { csrfToken: string };
    const response = await fetch("/api/runs", { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken }, body: JSON.stringify({ workflowId: "feature", idempotencyKey: crypto.randomUUID(), workspace: { repositoryPath } }) });
    if (!response.ok) throw new Error(await response.text());
    return ((await response.json()) as { id: string }).id;
  }, repositoryPath);
  await page.goto(`/?run=${encodeURIComponent(runId)}#token=${token}`);
  await expect(page.getByTestId("run-status")).toHaveText("running", { timeout: 10_000 });

  await page.getByRole("button", { name: "Open checkpoints and forks" }).first().click();
  await expect(page.getByText("ineligible", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Capture checkpoint" })).toBeDisabled();

  // Pause the run immediately (before the 5s scripted delay completes) so we
  // can still find the Pause button in the topbar run-controls.
  await page.getByRole("button", { name: "Toggle checkpoints and forks" }).click();
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByTestId("run-status")).toHaveText("paused", { timeout: 15_000 });

  // A paused run is eligible for checkpoint capture.
  await page.getByRole("button", { name: "Open checkpoints and forks" }).first().click();
  await expect(page.getByText("CHECKPOINT ELIGIBILITY")).toBeVisible();
  await expect(page.getByText("eligible", { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Capture checkpoint" })).toBeEnabled();
  await page.getByRole("button", { name: "Capture checkpoint" }).click();
  await expect(page.getByText("Checkpoint captured.")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByLabel("Child run name")).toBeEnabled();
  await expect(page.getByLabel("Execution profile for new work")).toHaveValue("");

  await page.getByLabel("Child run name").fill("browser-approaches");
  await page.getByLabel("Execution profile for new work").selectOption("pi-readonly");
  await page.getByText("Change an unexecuted agent prompt").click();
  await page.getByLabel("Agent node ID").fill("implement");
  await page.getByLabel("Replacement prompt").fill("Implement the task using the forked prompt.");
  await page.getByRole("button", { name: "Create isolated fork" }).click();
  await expect(page.getByText("Fork requested.")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("GENEALOGY", { exact: true })).toBeVisible();
  await expect(page.getByText("browser-approaches #1")).toBeVisible();
  await expect(page.getByText(/inherited/).first()).toBeVisible();
});

test("M7 checkpoint surface remains usable at 768px and is keyboard reachable", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 900 });
  await page.goto(`/#token=${token}`);
  await expect(page.getByTestId("start-run").first()).toBeEnabled();
  const tinyRunId = await page.evaluate(async () => {
    const runs = (await (await fetch("/api/runs")).json()) as Array<{ id: string; workflowId: string }>;
    return runs.find((run) => run.workflowId === "tiny")?.id;
  });
  expect(tinyRunId).toBeTruthy();
  await page.goto(`/?run=${encodeURIComponent(tinyRunId!)}#token=${token}`);

  const checkpointNav = page.getByRole("button", { name: "Toggle checkpoints and forks" }).first();
  await checkpointNav.focus();
  await expect(checkpointNav).toBeFocused();
  await checkpointNav.press("Enter");
  await expect(page.getByText("CHECKPOINT ELIGIBILITY")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});
