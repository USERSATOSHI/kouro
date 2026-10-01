import { expect, test, type Page } from "@playwright/test";

const harness = process.env.KOURO_LIVE_BROWSER_HARNESS ?? "codex";

async function openNative(page: Page, mode: string) {
  await page.goto("/#token=native-browser-test-token");
  const response = await page.request.post("/__native/run", { headers: { authorization: "Bearer native-browser-test-token" }, data: { mode } });
  expect(response.ok()).toBe(true);
  const fixture = await response.json() as { runId: string; marker: string };
  await page.goto(`/?run=${fixture.runId}`);
  await page.getByRole("button", { name: "Agent session", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "native-parent" });
  await expect(dialog).toBeVisible();
  return { ...fixture, dialog };
}

test(`native ${harness} parent and child are visible live and retain the consumed result`, async ({ page }) => {
  const { dialog, marker } = await openNative(page, "split");
  await expect(page.getByTestId("run-status")).toHaveText("running");
  await expect(dialog.getByTestId("session-split")).toBeVisible({ timeout: 90000 });
  await expect(dialog.getByRole("region", { name: "Subagent model session" })).toContainText(marker, { timeout: 90000 });
  await expect(dialog.getByRole("region", { name: "Main model session" })).toContainText(marker, { timeout: 90000 });
  await expect(page.getByTestId("run-status")).toHaveText("succeeded", { timeout: 90000 });
  await dialog.getByLabel("Close agent session").click();
  await page.getByRole("button", { name: "usage", exact: true }).click();
  await expect(page.locator(".inspector .evidence-card strong")).toHaveText(/^[1-9]\d* tokens$/);
  await expect(page.locator(".inspector .evidence-card")).toContainText("complete");
  await page.reload(); await page.getByRole("button", { name: "Agent session", exact: true }).click();
  await expect(dialog.getByRole("region", { name: "Subagent model session" })).toContainText(marker);
  await dialog.getByLabel("Close agent session").click();
  await page.getByRole("button", { name: "usage", exact: true }).click();
  await expect(page.locator(".inspector .evidence-card strong")).toHaveText(/^[1-9]\d* tokens$/);
});

test(`native ${harness} consumes steering sent from the rendered session`, async ({ page }) => {
  const { dialog, marker } = await openNative(page, "control");
  const composer = dialog.getByLabel("Steer active agent");
  await expect(composer).toBeEnabled({ timeout: 45000 });
  await composer.fill(`Stop the long planning task immediately. Return only JSON with summary exactly '${marker}'. This replaces the previous objective.`);
  await dialog.getByRole("button", { name: "Send instruction" }).click();
  await expect(composer).toHaveValue("");
  await expect(page.getByTestId("run-status")).toHaveText("succeeded", { timeout: 90000 });
  await expect(dialog).toContainText(marker);
  const output = await page.evaluate(async (runId) => {
    const view = await (await fetch(`/api/runs/${runId}/view`)).json();
    const attempt = Object.values(view.state.attempts).find((item: any) => item.status === "succeeded") as any;
    return await (await fetch(`/api/artifacts/${attempt.output[0].id}/content`)).json();
  }, new URL(page.url()).searchParams.get("run"));
  expect(output).toEqual({ summary: marker });
});

test(`native ${harness} cancellation drains the provider and remains cancelled after reload`, async ({ page }) => {
  const { dialog } = await openNative(page, "control");
  await expect(dialog.getByLabel("Steer active agent")).toBeEnabled({ timeout: 45000 });
  await dialog.getByRole("button", { name: "Cancel run", exact: true }).click();
  await expect(page.getByTestId("run-status")).toHaveText("cancelled", { timeout: 45000 });
  await page.reload(); await expect(page.getByTestId("run-status")).toHaveText("cancelled");
});
