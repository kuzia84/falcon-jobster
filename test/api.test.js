import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse('2026-03-02T09:00:00Z');

// Starts the app on a free port. The test moves the clock with `clock.now`.
async function startServer(db) {
  const clock = { now: T0 };
  const app = createApp({ db, now: () => clock.now });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = res.status === 204 ? null : await res.json();
    return { status: res.status, data };
  }
  return { server, clock, call };
}

function reportPath(from, to, employeeId) {
  const qs = new URLSearchParams({ from, to });
  if (employeeId) qs.set('employeeId', String(employeeId));
  return `/api/report?${qs}`;
}

describe('API', () => {
  let db, ctx;

  beforeEach(async () => {
    db = openDb(':memory:');
    ctx = await startServer(db);
  });

  afterEach(async () => {
    await new Promise((resolve) => ctx.server.close(resolve));
    db.close();
  });

  async function addEmployee(name) {
    const res = await ctx.call('POST', '/api/employees', { name });
    assert.equal(res.status, 201);
    return res.data;
  }

  describe('сотрудники', () => {
    test('создаёт сотрудника и показывает его в списке', async () => {
      const emp = await addEmployee('  Анна Тестова  ');
      assert.equal(emp.name, 'Анна Тестова');

      const list = await ctx.call('GET', '/api/employees');
      assert.equal(list.status, 200);
      assert.deepEqual(list.data.map((e) => e.name), ['Анна Тестова']);
      assert.equal(list.data[0].activeEntry, null);
    });

    test('пустое имя -> 400', async () => {
      const res = await ctx.call('POST', '/api/employees', { name: '   ' });
      assert.equal(res.status, 400);
      assert.ok(res.data.error);
    });

    test('дубль имени без учёта регистра -> 409', async () => {
      await addEmployee('Борис Пример');
      const res = await ctx.call('POST', '/api/employees', { name: 'борис пример' });
      assert.equal(res.status, 409);
    });
  });

  describe('таймер', () => {
    test('старт и стоп создают запись с длительностью', async () => {
      const emp = await addEmployee('Анна Тестова');
      const start = await ctx.call('POST', `/api/employees/${emp.id}/timer/start`, {
        description: 'Вёрстка формы',
      });
      assert.equal(start.status, 201);
      assert.equal(start.data.endedAt, null);

      ctx.clock.now = T0 + 90 * 60 * 1000;
      const stop = await ctx.call('POST', `/api/employees/${emp.id}/timer/stop`);
      assert.equal(stop.status, 200);
      assert.equal(stop.data.description, 'Вёрстка формы');
      assert.equal(stop.data.endedAt - stop.data.startedAt, 90 * 60 * 1000);
    });

    test('повторный старт -> 409, активная запись остаётся одна', async () => {
      const emp = await addEmployee('Анна Тестова');
      const path = `/api/employees/${emp.id}/timer/start`;
      assert.equal((await ctx.call('POST', path, { description: 'Задача 1' })).status, 201);

      const again = await ctx.call('POST', path, { description: 'Задача 2' });
      assert.equal(again.status, 409);

      const active = db
        .prepare('SELECT COUNT(*) AS n FROM entries WHERE employee_id = ? AND ended_at IS NULL')
        .get(emp.id);
      assert.equal(active.n, 1);

      const list = await ctx.call('GET', '/api/employees');
      assert.equal(list.data[0].activeEntry.description, 'Задача 1');
    });

    test('после остановки таймер можно запустить снова', async () => {
      const emp = await addEmployee('Анна Тестова');
      const base = `/api/employees/${emp.id}/timer`;
      await ctx.call('POST', `${base}/start`, { description: 'Задача 1' });
      ctx.clock.now += HOUR;
      await ctx.call('POST', `${base}/stop`);
      const again = await ctx.call('POST', `${base}/start`, { description: 'Задача 2' });
      assert.equal(again.status, 201);
    });

    test('таймеры разных сотрудников независимы', async () => {
      const a = await addEmployee('Анна Тестова');
      const b = await addEmployee('Борис Пример');
      const ra = await ctx.call('POST', `/api/employees/${a.id}/timer/start`, { description: 'A' });
      const rb = await ctx.call('POST', `/api/employees/${b.id}/timer/start`, { description: 'B' });
      assert.equal(ra.status, 201);
      assert.equal(rb.status, 201);
    });

    test('стоп без активного таймера -> 409', async () => {
      const emp = await addEmployee('Анна Тестова');
      const res = await ctx.call('POST', `/api/employees/${emp.id}/timer/stop`);
      assert.equal(res.status, 409);
    });

    test('пустое описание -> 400', async () => {
      const emp = await addEmployee('Анна Тестова');
      const res = await ctx.call('POST', `/api/employees/${emp.id}/timer/start`, {
        description: ' ',
      });
      assert.equal(res.status, 400);
    });

    test('несуществующий сотрудник -> 404', async () => {
      const start = await ctx.call('POST', '/api/employees/999/timer/start', { description: 'X' });
      assert.equal(start.status, 404);
      const stop = await ctx.call('POST', '/api/employees/999/timer/stop');
      assert.equal(stop.status, 404);
      const bad = await ctx.call('POST', '/api/employees/abc/timer/stop');
      assert.equal(bad.status, 404);
    });
  });

  describe('отчёт', () => {
    const FROM = '2026-03-02T00:00:00Z';
    const TO = '2026-03-03T00:00:00Z';

    test('пустой отчёт без сотрудников -> 200 и пустые списки', async () => {
      const res = await ctx.call('GET', reportPath(FROM, TO));
      assert.equal(res.status, 200);
      assert.deepEqual(res.data, { entries: [], totals: [] });
    });

    test('пустой отчёт: записей нет, у каждого сотрудника 0', async () => {
      const emp = await addEmployee('Анна Тестова');
      // A record outside the period must not get into the report.
      await ctx.call('POST', `/api/employees/${emp.id}/timer/start`, { description: 'Раньше' });
      ctx.clock.now += HOUR;
      await ctx.call('POST', `/api/employees/${emp.id}/timer/stop`);

      const res = await ctx.call('GET', reportPath('2026-04-01T00:00:00Z', '2026-04-02T00:00:00Z'));
      assert.equal(res.status, 200);
      assert.deepEqual(res.data.entries, []);
      assert.deepEqual(res.data.totals, [
        { employeeId: emp.id, name: 'Анна Тестова', totalMs: 0 },
      ]);
    });

    test('суммирует время каждого сотрудника', async () => {
      const a = await addEmployee('Анна Тестова');
      const b = await addEmployee('Борис Пример');
      await ctx.call('POST', `/api/employees/${a.id}/timer/start`, { description: 'A1' });
      await ctx.call('POST', `/api/employees/${b.id}/timer/start`, { description: 'B1' });
      ctx.clock.now += HOUR;
      await ctx.call('POST', `/api/employees/${a.id}/timer/stop`);
      await ctx.call('POST', `/api/employees/${a.id}/timer/start`, { description: 'A2' });
      ctx.clock.now += 2 * HOUR;
      await ctx.call('POST', `/api/employees/${a.id}/timer/stop`);
      await ctx.call('POST', `/api/employees/${b.id}/timer/stop`);

      const res = await ctx.call('GET', reportPath(FROM, TO));
      assert.equal(res.data.entries.length, 3);
      const totals = Object.fromEntries(res.data.totals.map((t) => [t.name, t.totalMs]));
      assert.deepEqual(totals, { 'Анна Тестова': 3 * HOUR, 'Борис Пример': 3 * HOUR });
    });

    test('фильтр по сотруднику', async () => {
      const a = await addEmployee('Анна Тестова');
      const b = await addEmployee('Борис Пример');
      await ctx.call('POST', `/api/employees/${a.id}/timer/start`, { description: 'A' });
      await ctx.call('POST', `/api/employees/${b.id}/timer/start`, { description: 'B' });
      ctx.clock.now += HOUR;

      const res = await ctx.call('GET', reportPath(FROM, TO, b.id));
      assert.deepEqual(res.data.entries.map((e) => e.description), ['B']);
      assert.deepEqual(res.data.totals.map((t) => t.name), ['Борис Пример']);
    });

    test('запись на границе периода: в итог идёт только часть внутри периода', async () => {
      const emp = await addEmployee('Анна Тестова');
      ctx.clock.now = Date.parse('2026-03-02T22:00:00Z');
      await ctx.call('POST', `/api/employees/${emp.id}/timer/start`, { description: 'Ночь' });
      ctx.clock.now = Date.parse('2026-03-03T03:00:00Z');
      await ctx.call('POST', `/api/employees/${emp.id}/timer/stop`);

      const day1 = await ctx.call('GET', reportPath(FROM, TO));
      assert.equal(day1.data.entries.length, 1);
      assert.equal(day1.data.totals[0].totalMs, 2 * HOUR);

      const day2 = await ctx.call('GET', reportPath(TO, '2026-03-04T00:00:00Z'));
      assert.equal(day2.data.totals[0].totalMs, 3 * HOUR);
    });

    test('активный таймер считается до текущего момента', async () => {
      const emp = await addEmployee('Анна Тестова');
      await ctx.call('POST', `/api/employees/${emp.id}/timer/start`, { description: 'Идёт' });
      ctx.clock.now += 45 * 60 * 1000;

      const res = await ctx.call('GET', reportPath(FROM, TO));
      assert.equal(res.data.entries[0].endedAt, null);
      assert.equal(res.data.totals[0].totalMs, 45 * 60 * 1000);
    });

    test('активный таймер, начатый до периода, обрезается по обеим границам', async () => {
      const emp = await addEmployee('Анна Тестова');
      ctx.clock.now = Date.parse('2026-03-01T20:00:00Z');
      await ctx.call('POST', `/api/employees/${emp.id}/timer/start`, { description: 'Долго' });
      ctx.clock.now = Date.parse('2026-03-05T00:00:00Z');

      const res = await ctx.call('GET', reportPath(FROM, TO));
      assert.equal(res.data.entries.length, 1);
      assert.equal(res.data.totals[0].totalMs, 24 * HOUR);
    });

    test('будущий период не включает идущий таймер', async () => {
      const emp = await addEmployee('Анна Тестова');
      await ctx.call('POST', `/api/employees/${emp.id}/timer/start`, { description: 'Идёт' });
      ctx.clock.now += HOUR;

      const res = await ctx.call('GET', reportPath('2026-03-10T00:00:00Z', '2026-03-11T00:00:00Z'));
      assert.deepEqual(res.data.entries, []);
      assert.equal(res.data.totals[0].totalMs, 0);
    });

    test('неверный период -> 400', async () => {
      assert.equal((await ctx.call('GET', '/api/report?from=abc&to=def')).status, 400);
      assert.equal((await ctx.call('GET', reportPath(TO, FROM))).status, 400);
      assert.equal((await ctx.call('GET', '/api/report')).status, 400);
    });

    test('период не в формате ISO -> 400', async () => {
      // Date.parse('1') gives a date in 2001, so a loose check lets it through.
      assert.equal((await ctx.call('GET', reportPath('1', '2'))).status, 400);
      // Without a zone the server would read the time in its own time zone.
      assert.equal((await ctx.call('GET', reportPath('2026-03-02T00:00', TO))).status, 400);
      assert.equal((await ctx.call('GET', reportPath('2026-03-02T00:00:00+03:00', TO))).status, 200);
    });

    test('неверный employeeId в отчёте', async () => {
      assert.equal((await ctx.call('GET', reportPath(FROM, TO, 'abc'))).status, 400);
      const unknown = await ctx.call('GET', reportPath(FROM, TO, 999));
      assert.equal(unknown.status, 200);
      assert.deepEqual(unknown.data, { entries: [], totals: [] });
    });
  });

  describe('ограничения ввода', () => {
    test('слишком длинное имя или описание -> 400', async () => {
      const longName = await ctx.call('POST', '/api/employees', { name: 'а'.repeat(101) });
      assert.equal(longName.status, 400);

      const emp = await addEmployee('Анна Тестова');
      const longTask = await ctx.call('POST', `/api/employees/${emp.id}/timer/start`, {
        description: 'з'.repeat(201),
      });
      assert.equal(longTask.status, 400);
    });

    test('тело запроса не JSON -> 400', async () => {
      const res = await fetch(new URL('/api/employees', `http://127.0.0.1:${ctx.server.address().port}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"name":',
      });
      assert.equal(res.status, 400);
    });

    test('часы сервера ушли назад: длительность не отрицательная', async () => {
      const emp = await addEmployee('Анна Тестова');
      await ctx.call('POST', `/api/employees/${emp.id}/timer/start`, { description: 'NTP' });
      ctx.clock.now -= 5 * 60 * 1000;
      const stop = await ctx.call('POST', `/api/employees/${emp.id}/timer/stop`);
      assert.equal(stop.data.endedAt, stop.data.startedAt);

      const res = await ctx.call('GET', reportPath('2026-03-02T00:00:00Z', '2026-03-03T00:00:00Z'));
      assert.equal(res.data.totals[0].totalMs, 0);
    });
  });
});

describe('сохранение данных', () => {
  test('данные остаются после перезапуска', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'timetracker-'));
    const file = join(dir, 'test.db');
    try {
      let db = openDb(file);
      let ctx = await startServer(db);
      const emp = (await ctx.call('POST', '/api/employees', { name: 'Анна Тестова' })).data;
      await ctx.call('POST', `/api/employees/${emp.id}/timer/start`, { description: 'Отчёт' });
      await new Promise((resolve) => ctx.server.close(resolve));
      db.close();

      db = openDb(file);
      ctx = await startServer(db);
      const list = await ctx.call('GET', '/api/employees');
      assert.equal(list.data[0].name, 'Анна Тестова');
      assert.equal(list.data[0].activeEntry.description, 'Отчёт');
      await new Promise((resolve) => ctx.server.close(resolve));
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
