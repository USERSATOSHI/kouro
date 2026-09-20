import { expect, test } from "@playwright/test";

const token = "kouro-browser-test-token";

test("M5 experiment matrix, durable comparison timeline, and blinded review", async ({ page }) => {
  await page.goto(`/#token=${token}`);
  await expect(page.getByTestId("start-run").first()).toBeEnabled();
  const experimentId = `browser-3x3x2-${Date.now()}`;
  const csrf = await page.evaluate(async () => ((await (await fetch("/api/session")).json()) as { csrfToken: string }).csrfToken);
  const workflowDigest = await page.evaluate(async () => {
    const workflows = (await (await fetch("/api/workflows")).json()) as Array<{ id: string; digest: string }>;
    return workflows.find((workflow) => workflow.id === "tiny")?.digest ?? "";
  });
  const definition = {
    id: experimentId,
    dataset: { id: `${experimentId}-dataset`, version: "1", cases: ["alpha", "beta", "gamma"].map((id) => ({ id, input: { task: id } })) },
    repetitions: 2,
    maxConcurrent: 6,
    variants: ["baseline", "quality", "experimental"].map((id) => ({ id, workflowId: "tiny", workflowDigest, executionProfile: "scripted" })),
  };
  const created = await page.evaluate(async ({ definition, csrf }) => {
    const response = await fetch("/api/experiments", { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify(definition) });
    return { status: response.status, body: await response.json() };
  }, { definition, csrf });
  expect(created.status).toBe(200);
  await page.evaluate(({ experimentId, csrf }) => {
    void fetch(`/api/experiments/${encodeURIComponent(experimentId)}/resume`, { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify({ actor: "browser", maxConcurrent: 6 }) });
  }, { experimentId, csrf });
  await expect.poll(async () => page.evaluate(async (id) => (await (await fetch(`/api/experiments/${encodeURIComponent(id)}`)).json()) as { status: string }, experimentId).then((snapshot) => snapshot.status), { timeout: 25_000 }).toBe("completed");

  await page.reload();
  await page.getByRole("button", { name: "Evaluations", exact: true }).click();
  await expect(page.getByTestId("eval-workbench")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("EXPERIMENT MATRIX")).toBeVisible();
  await expect(page.locator(".eval-cell")).toHaveCount(9);
  await expect(page.locator(".eval-cell.succeeded").first()).toBeVisible();

  // A matrix cell opens evidence first; the ordinary run link then returns to
  // the existing graph/timeline workbench rather than a parallel eval viewer.
  await page.locator(".eval-cell.succeeded").first().click();
  await expect(page.getByTestId("evidence-detail")).toBeVisible();
  await page.getByRole("button", { name: /Open normal run/ }).click();
  await expect(page.getByTestId("workflow-graph")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("execution-timeline")).toBeVisible();

  await page.getByRole("button", { name: "Evaluations", exact: true }).click();
  await page.getByRole("button", { name: "TIMELINE COMPARE" }).click();
  await expect(page.getByText("SHARED-SCALE TIMELINE")).toBeVisible();
  await expect(page.locator(".compare-row").first()).toBeVisible({ timeout: 15_000 });
  expect(await page.locator(".compare-bar").count()).toBeGreaterThan(0);

  await page.getByRole("button", { name: "PAIRWISE REVIEW" }).click();
  await expect(page.getByRole("button", { name: "Start review" })).toBeVisible();
  await page.getByRole("button", { name: "Start review" }).click();
  await expect(page.getByRole("button", { name: "A better" })).toBeEnabled({ timeout: 10_000 });
  await page.getByRole("button", { name: "A better" }).click();
  await expect(page.getByText(/Decision recorded: a/)).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Reveal identities" }).click();
  await expect(page.getByText(/baseline/)).toBeVisible();
  await page.screenshot({ path: "test-results/m5-evals-desktop.png", fullPage: true });
});

test("M5 evaluation workbench remains usable at 768px", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 900 });
  await page.goto(`/#token=${token}`);
  await expect(page.getByTestId("start-run").first()).toBeEnabled();
  const responsiveCsrf = await page.evaluate(async () => ((await (await fetch("/api/session")).json()) as { csrfToken: string }).csrfToken);
  const responsiveDigest = await page.evaluate(async () => ((await (await fetch("/api/workflows")).json()) as Array<{ id: string; digest: string }>).find((workflow) => workflow.id === "tiny")?.digest ?? "");
  await page.evaluate(async ({ csrf, digest }) => {
    await fetch("/api/experiments", { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify({ id: `browser-responsive-${Date.now()}`, dataset: { id: `responsive-${Date.now()}`, version: "1", cases: [{ id: "case", input: { task: "responsive" } }] }, repetitions: 1, variants: [{ id: "baseline", workflowId: "tiny", workflowDigest: digest, executionProfile: "scripted" }] }) });
  }, { csrf: responsiveCsrf, digest: responsiveDigest });
  await page.reload();
  await expect(page.getByTestId("start-run").first()).toBeEnabled();
  await page.getByRole("button", { name: "Evaluations", exact: true }).click();
  await expect(page.getByTestId("eval-workbench")).toBeVisible({ timeout: 15_000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: "test-results/m5-evals-768.png", fullPage: true });
});
