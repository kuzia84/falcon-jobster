import { defineConfig, devices } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 3457;
// A new database file for every run, so the tests never see old data.
// The path goes into an environment variable: workers load this file again
// and inherit the variable. e2e/cleanup.js deletes files of earlier runs.
process.env.UI_TEST_DB ??= join(tmpdir(), `timetracker-ui-${process.pid}-${Date.now()}.db`);
const DB_PATH = process.env.UI_TEST_DB;

export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/cleanup.js',
  // All tests share one server and one database. One worker keeps them
  // independent of each other's timing.
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: 'node src/server.js',
    url: `http://localhost:${PORT}/api/employees`,
    env: { PORT: String(PORT), DB_PATH },
    reuseExistingServer: false,
  },
});
