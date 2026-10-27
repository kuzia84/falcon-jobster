import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

// Resolved from the project folder, so the start directory does not matter.
export const DEFAULT_DB_PATH = fileURLToPath(new URL('../data/timetracker.db', import.meta.url));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS employees (
  id         INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL,
  -- Lower-case name for uniqueness and sorting. SQLite NOCASE folds only ASCII,
  -- so it treats 'Борис' and 'борис' as different names.
  name_key   TEXT    NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS entries (
  id          INTEGER PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  description TEXT    NOT NULL,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER
);

-- One active timer per employee. The database enforces it, not only the code.
CREATE UNIQUE INDEX IF NOT EXISTS one_active_timer
  ON entries(employee_id) WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS entries_started_at ON entries(started_at);
-- The report totals join entries by employee and period start.
CREATE INDEX IF NOT EXISTS entries_employee_started ON entries(employee_id, started_at);
`;

// Opens (or creates) the database and applies the schema.
// Times are stored as UTC milliseconds.
export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}
