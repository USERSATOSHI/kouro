import { expect, test } from "@playwright/test";

test("choose models first, assign a task, launch and reload durable swarm answers", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/#token=kouro-browser-test-token");
  await page.getByRole("button", { name: "Agent swarm", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Agent swarm", exact: true })).toBeVisible();
  await expect(page.getByLabel("Swarm task")).toBeDisabled();
  await expect(page.getByTestId("start-swarm")).toBeDisabled();
  await page.getByLabel("Harness 1").selectOption("opencode");
  await page.getByRole("textbox", { name: "Model 1", exact: true }).fill("first");
  await page.getByRole("button", { name: "Add model", exact: true }).click();
  await page.getByRole("textbox", { name: "Model 2", exact: true }).fill("second");
  await page.getByRole("button", { name: "Add model", exact: true }).click();
  await expect(page.getByLabel("Swarm task")).toBeDisabled();
  await page.getByRole("button", { name: "Remove model 3", exact: true }).click();
  await page.getByLabel("Swarm task").fill("Compare two approaches");
  const createdResponse = page.waitForResponse(
    (response) => response.url().endsWith("/api/swarms") && response.request().method() === "POST",
  );
  await page.getByTestId("start-swarm").click();
  const created = await createdResponse;
  expect(created.ok()).toBe(true);
  expect(created.request().postDataJSON().models).toEqual([
    { harness: "opencode", modelId: "first" },
    { harness: "opencode", modelId: "second" },
  ]);
  const run = await created.json();
  await expect(page.getByText(/Agent swarm · 2 members/)).toBeVisible();
  await expect(page.getByTestId("run-status")).toHaveText("succeeded");
  await expect(page.getByText("Final answer", { exact: true })).toBeVisible();
  await expect(page.getByText(/member1: first: Compare two approaches/)).toBeVisible();
  await expect(page.getByText(/member2: second: Compare two approaches/)).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Swarm activity", exact: true }).click();
  await expect(page.getByText("Final answer", { exact: true })).toBeVisible();
  const snapshot = await (await page.request.get(`/api/runs/${run.id}/collaboration`)).json();
  expect(snapshot.participants.map((item: { model: string }) => item.model)).toEqual([
    "first",
    "second",
  ]);
  expect(snapshot.results.filter((item: { final: boolean }) => item.final)).toHaveLength(1);
  await page.getByRole("button", { name: "New swarm", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Model 1", exact: true })).toHaveValue("");
  expect(errors).toEqual([]);
});

test("swarm creation fits a narrow screen and its live model activity can be opened and cancelled", async ({
  page,
}) => {
  await page.setViewportSize({ width: 768, height: 900 });
  await page.goto("/#token=kouro-browser-test-token");
  await page.getByRole("button", { name: "Toggle navigation", exact: true }).click();
  await page.getByRole("button", { name: "Agent swarm", exact: true }).click();
  await page.getByLabel("Harness 1").selectOption("opencode");
  await page.getByRole("textbox", { name: "Model 1", exact: true }).fill("slow");
  await page.getByLabel("Swarm task").fill("Watch this model work");
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.getByTestId("start-swarm").click();
  await expect(page.getByText(/Agent swarm · 1 member/)).toBeVisible();
  await page.getByRole("button", { name: "Select slow", exact: true }).click();
  await page.getByRole("button", { name: "Open agent activity", exact: true }).click();
  await expect(page.getByText("Fixture model slow started", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Swarm activity", exact: true }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByTestId("run-status")).toHaveText("cancelled");
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});
