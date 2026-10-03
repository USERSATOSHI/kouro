import { defineConfig } from "@playwright/test";

const port = Number(process.env.KOURO_DOCS_TEST_PORT ?? 4174);
const baseURL = `http://127.0.0.1:${port}/kouro/`;
export default defineConfig({
  testDir: "./tests/docs",
  workers: 1,
  reporter: "list",
  timeout: 30_000,
  use: {
    baseURL,
    viewport: { width: 1440, height: 960 },
    screenshot: "only-on-failure",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {},
  },
  webServer: {
    command: "bun run docs:preview",
    url: baseURL,
    reuseExistingServer: false,
    env: { KOURO_DOCS_PORT: String(port), KOURO_DOCS_BASE_PATH: "/kouro/" },
  },
});
