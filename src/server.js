import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDb, DEFAULT_DB_PATH } from './db.js';
import { createApp } from './app.js';

const port = Number(process.env.PORT) || 3000;
const dbPath = process.env.DB_PATH || DEFAULT_DB_PATH;

mkdirSync(dirname(dbPath), { recursive: true });
const db = openDb(dbPath);
const server = createApp({ db }).listen(port, () => {
  console.log(`Учёт времени: http://localhost:${port} (база: ${dbPath})`);
});

// A second Ctrl+C must not close the database again.
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
