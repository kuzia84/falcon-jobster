import express from 'express';
import { fileURLToPath } from 'node:url';
import { createRepo, AppError } from './repo.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));

// Parses a positive integer id. Returns NaN for anything else.
function parseId(value) {
  return /^\d+$/.test(value) ? Number(value) : NaN;
}

// ISO date-time with an explicit zone. Date.parse alone is too loose:
// it reads '1' as a date in 2001 and a time without a zone as server-local time.
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function parseInstant(value, name) {
  const ms = ISO_INSTANT.test(value ?? '') ? Date.parse(value) : NaN;
  if (Number.isNaN(ms)) {
    throw new AppError(400, `Параметр ${name} должен быть датой ISO с часовым поясом`);
  }
  return ms;
}

// `now` is injectable so tests control the clock.
export function createApp({ db, now = Date.now }) {
  const repo = createRepo(db);
  const app = express();

  app.use(express.json());
  app.use(express.static(PUBLIC_DIR));

  app.get('/api/employees', (req, res) => {
    res.json(repo.listEmployees());
  });

  app.post('/api/employees', (req, res) => {
    res.status(201).json(repo.createEmployee(req.body?.name, now()));
  });

  app.post('/api/employees/:id/timer/start', (req, res) => {
    const entry = repo.startTimer(parseId(req.params.id), req.body?.description, now());
    res.status(201).json(entry);
  });

  app.post('/api/employees/:id/timer/stop', (req, res) => {
    res.json(repo.stopTimer(parseId(req.params.id), now()));
  });

  app.get('/api/report', (req, res) => {
    const from = parseInstant(req.query.from, 'from');
    const to = parseInstant(req.query.to, 'to');
    if (from >= to) throw new AppError(400, 'Начало периода должно быть раньше конца');

    let employeeId;
    if (req.query.employeeId) {
      employeeId = parseId(req.query.employeeId);
      if (Number.isNaN(employeeId)) throw new AppError(400, 'Неверный employeeId');
    }
    res.json(repo.report({ from, to, employeeId }, now()));
  });

  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Не найдено' });
  });

  // Express 5 passes errors from sync handlers here.
  app.use((err, req, res, next) => {
    if (err instanceof AppError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Тело запроса должно быть JSON' });
    }
    console.error(err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  });

  return app;
}
