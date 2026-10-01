import { defineConfig } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const port = Number(process.env.KOURO_TEST_PORT ?? 43282);
export default defineConfig({
  testDir: "./tests/native-browser",
  timeout: 160000,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1440, height: 960 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {},
  },
  webServer: {
    command: "bun run --cwd packages/web build && bun run scripts/browser-native-dev.ts",
    url: `http://127.0.0.1:${port}`,
    timeout: 60000,
    reuseExistingServer: false,
    env: {
      KOURO_PORT: String(port),
      KOURO_DATA_DIR: mkdtempSync(join(tmpdir(), "kouro-native-browser-")),
      KOURO_TOKEN: "native-browser-test-token",
      KOURO_LIVE_BROWSER_MODEL: process.env.KOURO_LIVE_BROWSER_MODEL ?? "",
      KOURO_LIVE_BROWSER_HARNESS: process.env.KOURO_LIVE_BROWSER_HARNESS ?? "codex",
    },
  },
});
