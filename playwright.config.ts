import { defineConfig } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = Number(process.env.KOURO_TEST_PORT ?? 43127);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/browser",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL,
    viewport: { width: 1440, height: 960 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {},
  },
  webServer: {
    command: "bun run --cwd packages/web build && bun run scripts/browser-collaboration-dev.ts",
    url: baseURL,
    timeout: 60_000,
    reuseExistingServer: false,
    env: {
      KOURO_PORT: String(port),
      KOURO_DATA_DIR: mkdtempSync(join(tmpdir(), "kouro-browser-")),
      KOURO_TOKEN: "kouro-browser-test-token",
    },
  },
});
