import { readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

// Deletes databases of earlier test runs. It runs before the tests, not after:
// Playwright calls globalTeardown while the server still runs, and on Windows
// SQLite still holds the file then. So the last run leaves one file behind.
export default function cleanup() {
  const current = process.env.UI_TEST_DB;
  const dir = dirname(current);
  for (const name of readdirSync(dir)) {
    if (name.startsWith('timetracker-ui-') && name !== basename(current)) {
      rmSync(join(dir, name), { force: true });
    }
  }
}
