import { expect, test } from "@playwright/test";

test("M8 prompt and schema fixtures run through the local API without launching a workflow", async ({ page }) => {
  await page.goto("/#token=kouro-browser-test-token");
  await expect(page.getByTestId("start-run").first()).toBeEnabled();
  const before = await page.evaluate(async () => (await (await fetch("/api/runs")).json() as unknown[]).length);
  await page.getByRole("button", { name: "Developer tools", exact: true }).last().click();
  await expect(page.getByRole("heading", { name: "Prompt & schema playground" })).toBeVisible();
  await page.getByRole("button", { name: "Validate schema" }).click();
  await expect(page.locator(".dev-result")).toContainText('"valid": true');
  await page.getByRole("button", { name: "Render prompt" }).click();
  await expect(page.locator(".dev-result")).toContainText("Summarize");
  const after = await page.evaluate(async () => (await (await fetch("/api/runs")).json() as unknown[]).length);
  expect(after).toBe(before);
  await page.getByRole("button", { name: "Run prompt fixture" }).click();
  await expect(page.locator(".dev-result")).toContainText("Started ordinary run", { timeout: 10_000 });
  await page.getByRole("button", { name: /Open run run_/ }).click();
  await expect(page.getByTestId("workflow-graph")).toBeVisible();
  await expect(page.getByTestId("run-status")).toHaveText("succeeded", { timeout: 15_000 });
  await page.getByRole("button", { name: "Show workflow outline" }).click();
  await expect(page.getByRole("region", { name: "Workflow outline" })).toContainText("prompt");
  await page.getByRole("region", { name: "Workflow outline" }).getByRole("button", { name: /prompt · succeeded/ }).click();
  await page.getByRole("button", { name: "logs", exact: true }).click();
  await expect(page.getByRole("searchbox", { name: "Search logs" })).toBeVisible();
});

test("M8 development tools remain keyboard reachable at 768px", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 900 });
  await page.goto("/#token=kouro-browser-test-token");
  await expect(page.getByTestId("start-run").first()).toBeEnabled();
  const nav = page.getByRole("button", { name: "Developer tools", exact: true }).last();
  await nav.focus();
  await nav.press("Enter");
  await expect(page.getByRole("heading", { name: "Prompt & schema playground" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});
