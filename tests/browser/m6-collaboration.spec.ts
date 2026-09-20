import { expect, test } from "@playwright/test";

const token = "kouro-browser-test-token";

test("M6 collaboration view renders the durable host snapshot", async ({ page }) => {
  await page.goto(`/#token=${token}`);
  await expect(page.getByTestId("start-run").first()).toBeEnabled();
  const fixtureRunId = await page.evaluate(async () => {
    const runs = (await (await fetch("/api/runs")).json()) as Array<{ id: string }>;
    for (const run of runs) {
      const response = await fetch(`/api/runs/${encodeURIComponent(run.id)}/collaboration`);
      if (response.ok && ((await response.json()) as { participants?: unknown[] }).participants?.length) return run.id;
    }
    return null;
  });
  expect(fixtureRunId).toBeTruthy();
  await page.goto(`/?run=${encodeURIComponent(fixtureRunId!)}#token=${token}`);
  await page.getByRole("button", { name: "Collaboration", exact: true }).first().click();

  await expect(page.getByText("M6 · COLLABORATION")).toBeVisible();
  await expect(page.getByText("planner").first()).toBeVisible();
  await expect(page.getByText("reviewer").first()).toBeVisible();
  await expect(page.getByText("Direct message stream")).toBeVisible();
  await expect(page.getByText("The scripted fixture found a durable handoff.")).toBeVisible();
  await expect(page.getByText("Blackboard & artifacts")).toBeVisible();
  await expect(page.getByText("Review the generated artifact before handoff.").first()).toBeVisible();
  await expect(page.getByText("Participant timeline")).toBeVisible();
  await expect(page.getByText(/sender attempt/).first()).toBeVisible();
  await expect(page.getByText("MESSAGES", { exact: true })).toBeVisible();

  // The assertion goes through the live authenticated host endpoint rather
  // than a browser route mock, proving the rendered run id is durable data.
  // The fixture run is the oldest run (created at server startup before m5/m7).
  // Find it by checking which run has collaboration data.
  const snapshot = await page.evaluate(async () => {
    const runs = (await (await fetch("/api/runs")).json()) as Array<{ id: string }>;
    for (const run of runs) {
      const resp = await fetch(`/api/runs/${encodeURIComponent(run.id)}/collaboration`);
      if (resp.ok) {
        const data = await resp.json();
        if (data.participants?.length > 0) return data;
      }
    }
    return null;
  });
  expect(snapshot).toMatchObject({
    participants: expect.arrayContaining([expect.objectContaining({ id: "planner" })]),
    messages: expect.arrayContaining([expect.objectContaining({ senderAttemptId: expect.any(String) })]),
    blackboard: expect.arrayContaining([expect.objectContaining({ channelId: "blackboard:findings" })]),
  });
});

test("M6 collaboration view remains usable at 768px", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 900 });
  await page.goto(`/#token=${token}`);
  await expect(page.getByTestId("start-run").first()).toBeEnabled();
  const fixtureRunId = await page.evaluate(async () => {
    const runs = (await (await fetch("/api/runs")).json()) as Array<{ id: string }>;
    for (const run of runs) {
      const response = await fetch(`/api/runs/${encodeURIComponent(run.id)}/collaboration`);
      if (response.ok && ((await response.json()) as { participants?: unknown[] }).participants?.length) return run.id;
    }
    return null;
  });
  expect(fixtureRunId).toBeTruthy();
  await page.goto(`/?run=${encodeURIComponent(fixtureRunId!)}#token=${token}`);
  await page.getByRole("button", { name: "Collaboration", exact: true }).last().click();
  await expect(page.getByText("Direct message stream")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: "test-results/m6-collaboration-768.png", fullPage: true });
});
