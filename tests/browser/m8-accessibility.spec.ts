import { expect, test } from "@playwright/test";

test("M8 graph outline, timeline, and logs remain keyboard-operable at 768px", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 900 });
  await page.goto("/#token=kouro-browser-test-token");
  const launch = page.getByTestId("start-run").first();
  await expect(launch).toBeEnabled();
  await launch.focus();
  await launch.press("Enter");
  await expect(page.getByTestId("run-status")).toHaveText("succeeded", { timeout: 20_000 });

  const outlineToggle = page.getByRole("button", { name: "Show workflow outline" });
  await outlineToggle.focus();
  await outlineToggle.press("Enter");
  const outline = page.getByRole("region", { name: "Workflow outline" });
  await expect(outline).toBeVisible();
  const outlineEntry = outline.getByRole("button").first();
  await outlineEntry.focus();
  await outlineEntry.press("Enter");
  await expect(outlineEntry).toHaveAttribute("aria-current", "true");
  await expect(page.getByTestId("node-inspector")).toBeVisible();

  const timelineBar = page.locator('[data-testid="timeline-bar"]').first();
  await timelineBar.focus();
  await timelineBar.press("Enter");
  await expect(page.getByTestId("node-inspector")).toHaveAttribute(
    "data-invocation-id",
    (await timelineBar.getAttribute("data-invocation-id"))!,
  );

  const logsTab = page.getByRole("button", { name: "logs", exact: true });
  await logsTab.focus();
  await logsTab.press("Enter");
  const search = page.getByRole("searchbox", { name: "Search logs" });
  await search.focus();
  await search.fill("not-present-in-fixture");
  await expect(page.getByRole("log")).toContainText(/No logs match|No readable logs/);
  const follow = page.getByRole("button", { name: "Following" });
  await follow.focus();
  await follow.press("Enter");
  await expect(page.getByRole("button", { name: "Follow logs" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});
