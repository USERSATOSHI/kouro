import { expect, test, type Page } from "@playwright/test";

async function openFusion(page: Page, workflowId: string) {
  await page.goto("/#token=kouro-browser-test-token");
  const runId = await page.evaluate(async (workflowId) => {
    for (let count = 0; count < 50; count++) {
      const response = await fetch("/api/runs");
      if (response.ok) {
        const runs = (await response.json()) as Array<{ id: string; workflowId: string }>;
        const run = runs.find((run) => run.workflowId === workflowId);
        if (run) return run.id;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Fusion fixture is missing");
  }, workflowId);
  await page.goto(`/?run=${encodeURIComponent(runId)}`);
  await page.getByRole("tab", { name: "Session", exact: true }).click();
  await page.getByRole("radio", { name: "Fusion split", exact: true }).check();
  return runId;
}

test("fusion split compares both models across rounds and replays the combined plan after reload", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openFusion(page, "browser-fusion");
  const left = page.getByTestId("fusion-session-1");
  const right = page.getByTestId("fusion-session-2");
  await expect(page.getByTestId("run-status")).toHaveText("succeeded");
  await expect(left).toContainText("model-a revision round 2");
  await expect(right).toContainText("model-b revision round 2");
  await expect(page.getByTestId("fusion-combined-plan")).toContainText(
    "Combined: model-a revision round 2; model-b revision round 2",
  );
  await page.getByLabel("Planning stage", { exact: true }).selectOption("0");
  await expect(left).toContainText("model-a draft round 0: Compare approaches");
  await expect(right).toContainText("model-b draft round 0: Compare approaches");
  await page.getByLabel("Planning stage", { exact: true }).selectOption("1");
  await expect(left).toContainText("model-a review round 1");
  await expect(right).toContainText("model-b review round 1");
  await page.reload();
  await page.getByRole("tab", { name: "Session", exact: true }).click();
  await expect(page.getByRole("radio", { name: "Fusion split", exact: true })).toBeChecked();
  await expect(left).toContainText("model-a revision round 2");
  await expect(right).toContainText("model-b revision round 2");
  await page.setViewportSize({ width: 768, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.getByText("Single session", { exact: true }).click();
  await expect(page.getByTestId("fusion-sessions")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("live fusion steering targets one model and cancellation drains both review sessions", async ({
  page,
}) => {
  const runId = await openFusion(page, "browser-fusion-live");
  const left = page.getByTestId("fusion-session-1");
  const right = page.getByTestId("fusion-session-2");
  await expect(left).toContainText("model-a review round 1 started");
  await expect(right).toContainText("model-b review round 1 started");
  await left.getByLabel("Steer active agent").fill("Focus on recovery");
  await left.getByRole("button", { name: "Send instruction", exact: true }).click();
  await expect(left).toContainText("Instruction received by model-a: Focus on recovery");
  await expect(right).not.toContainText("Focus on recovery");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByTestId("run-status")).toHaveText("cancelled");
  await expect(left.getByLabel("Steer active agent")).toHaveCount(0);
  await expect(right.getByLabel("Steer active agent")).toHaveCount(0);
  const view = await (await page.request.get(`/api/runs/${runId}/view`)).json();
  expect(
    Object.values(view.state.invocations).some(
      (invocation: any) => invocation.nodeId.includes("revise") || invocation.nodeId === "fusion",
    ),
  ).toBe(false);
});
