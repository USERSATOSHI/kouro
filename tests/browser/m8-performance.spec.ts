import { expect, test } from "@playwright/test";
import { m8PerformanceFixture } from "../../scripts/browser-m8-performance-fixture";

declare global {
  interface Window {
    __m8MeasureSelection: () => Promise<number>;
    __m8MeasureScrollFrames: () => Promise<{ frames: number; p95FrameMs: number }>;
  }
}

test("M8 real GraphPanel and Timeline handle the large-data target", async ({ page }) => {
  const fixture = m8PerformanceFixture();
  await page.route("**/api/session**", async (route) => route.fulfill({ json: { csrfToken: "m8" } }));
  await page.route("**/api/workflows**", async (route) => route.fulfill({ json: [fixture.workflow] }));
  await page.route("**/api/runs**", async (route) => {
    if (route.request().url().includes("/view")) return route.fulfill({ json: fixture.run });
    if (route.request().url().includes("/stream")) return route.fulfill({ status: 200, contentType: "text/event-stream", body: ": m8 fixture\n\n" });
    return route.fulfill({ json: [{ id: fixture.run.runId, workflowId: fixture.workflow.id, state: "running" }] });
  });
  await page.route("**/api/execution-profiles**", async (route) => route.fulfill({ json: [] }));
  await page.route("**/api/experiments**", async (route) => route.fulfill({ json: [] }));
  await page.addInitScript(() => {
    window.__m8MeasureSelection = async () => {
      const node = document.querySelectorAll<HTMLElement>(".work-node")[499];
      if (!node) throw new Error("500th GraphPanel node was not rendered");
      const started = performance.now();
      const done = new Promise<number>((resolve) => {
        const observer = new MutationObserver(() => {
          if (document.querySelector("[data-testid=node-inspector]")?.getAttribute("data-invocation-id")) {
            observer.disconnect(); resolve(performance.now() - started);
          }
        });
        observer.observe(document.body, { subtree: true, childList: true, attributes: true });
      });
      node.click();
      return done;
    };
    window.__m8MeasureScrollFrames = async () => {
      const scroll = document.querySelector<HTMLElement>(".timeline-scroll");
      if (!scroll) throw new Error("Timeline scroll viewport was not rendered");
      const times: number[] = [];
      return new Promise((resolve) => {
        let frame = 0;
        const tick = (time: number) => {
          times.push(time);
          scroll.scrollTop = (frame * 97) % Math.max(1, scroll.scrollHeight - scroll.clientHeight);
          frame += 1;
          if (frame < 90) requestAnimationFrame(tick);
          else {
            const intervals = times.slice(1).map((value, index) => value - times[index]).sort((a, b) => a - b);
            resolve({ frames: times.length, p95FrameMs: intervals[Math.floor(intervals.length * 0.95)] ?? 0 });
          }
        };
        requestAnimationFrame(tick);
      });
    };
  });
  const started = Date.now();
  await page.goto("/?run=m8-browser-fixture#token=m8");
  await expect(page.getByTestId("workflow-graph")).toBeVisible();
  await expect(page.getByTestId("execution-timeline")).toBeVisible();
  await expect(page.locator(".work-node")).toHaveCount(500);
  const graphMs = Date.now() - started;
  const renderedBars = await page.locator('[data-testid="timeline-bar"]').count();
  expect(renderedBars).toBeGreaterThan(0);
  const selectionMs = await page.evaluate(() => window.__m8MeasureSelection());
  const frames = await page.evaluate(() => window.__m8MeasureScrollFrames());
  const measurement = {
    graphMs,
    selectionMs,
    renderedBars,
    ...frames,
    graphNodes: await page.locator(".work-node").count(),
    timelineSpans: Object.keys(fixture.run.state.invocations).length,
  };
  console.info("M8 real browser performance", measurement);
  // Reference: Linux x64, Chromium headless, Intel i5-1135G7, 2026-09-20.
  // Generous shared-CI budgets; these are acceptance signals, not guarantees.
  expect(measurement.graphNodes).toBe(500);
  expect(measurement.timelineSpans).toBe(10_000);
  expect(measurement.renderedBars).toBeLessThan(100);
  expect(measurement.graphMs).toBeLessThan(4_000);
  expect(measurement.selectionMs).toBeLessThan(250);
  expect(measurement.frames).toBeGreaterThanOrEqual(80);
  expect(measurement.p95FrameMs).toBeLessThan(50);
});
