import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

test("learning pages link to examples and the generated API", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("./");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Write workflows.");
  await page.screenshot({ path: "test-results/docs-home-desktop.png", fullPage: true });
  await page.getByRole("link", { name: "Write your first workflow" }).click();
  await expect(page.getByRole("heading", { name: "Your task. Your workflow." })).toBeVisible();
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "API reference" })
    .click();
  const nav = page.getByRole("navigation", { name: "Kouro documentation" });
  await expect(nav.getByRole("link", { name: "Examples" })).toBeVisible();
  await page.goto("api/classes/WorkflowBuilder.html");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("WorkflowBuilder");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("combobox").fill("milestones");
  const result = page
    .locator('#tsd-search-results a[href$="WorkflowBuilder.html#milestones"]')
    .first();
  await expect(result).toBeVisible();
  await result.click();
  await expect(page).toHaveURL(/WorkflowBuilder\.html#milestones$/);
  await expect(page.getByRole("dialog", { name: "Search", exact: true })).not.toBeVisible();
  await expect(page.locator("#milestones")).toBeInViewport();
  await expect(nav.getByRole("link", { name: "Learn" })).toHaveAttribute(
    "href",
    /\/kouro\/guide\.html$/,
  );
  await nav.getByRole("link", { name: "Examples" }).click();
  await expect(page.locator("[data-example]")).toHaveCount(7);
  expect(errors).toEqual([]);
});

test("examples filter, show exact source code, and provide downloads", async ({ page }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("examples.html");
  await page.getByRole("searchbox", { name: "Find an example" }).fill("deep research");
  await expect(page.locator("[data-example]:visible")).toHaveCount(1);
  await expect(page.getByRole("status")).toHaveText("1 example");
  await page.getByRole("searchbox").fill("");
  const example = page.locator("#feature-fusion");
  await example.getByText("Read kouro.ts", { exact: true }).click();
  const source = await readFile(resolve("docs/examples/feature-fusion.ts"), "utf8");
  await expect(example.locator("#feature-fusion-code")).toHaveText(source, { useInnerText: false });
  await example.getByRole("button", { name: "Copy kouro.ts" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(source);
  const download = page.waitForEvent("download");
  await example.getByRole("link", { name: "Download complete workflow" }).click();
  expect((await download).suggestedFilename()).toBe("feature-fusion.tar.gz");
});

test("mobile and dark mode keep the documentation within the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  for (const url of ["./", "guide.html", "examples.html"]) {
    await page.goto(url);
    await expect(
      page
        .getByRole("navigation", { name: "Main navigation" })
        .getByRole("link", { name: "Examples" }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
  await page.locator("#spec-implementation").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/docs-examples-mobile.png", fullPage: true });
});
