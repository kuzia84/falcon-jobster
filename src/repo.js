export const MAX_NAME = 100;
export const MAX_DESCRIPTION = 200;

export class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function toEntry(row) {
  return {
    id: row.id,
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    description: row.description,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

function isUniqueViolation(err) {
  return /UNIQUE constraint failed/.test(err?.message ?? '');
}

// An entry overlaps [from, to). An active entry (ended_at IS NULL) lasts until `now`.
const OVERLAPS_PERIOD = 'en.started_at < :to AND COALESCE(en.ended_at, :now) > :from';

export function createRepo(db) {
  const stmt = {
    listEmployees: db.prepare(`
      SELECT e.id, e.name, a.id AS entry_id, a.description, a.started_at
      FROM employees e
      LEFT JOIN entries a ON a.employee_id = e.id AND a.ended_at IS NULL
      ORDER BY e.name_key`),
    getEmployee: db.prepare('SELECT id, name FROM employees WHERE id = ?'),
    insertEmployee: db.prepare('INSERT INTO employees (name, name_key, created_at) VALUES (?, ?, ?)'),
    insertEntry: db.prepare(
      'INSERT INTO entries (employee_id, description, started_at) VALUES (?, ?, ?)',
    ),
    stopActive: db.prepare(
      // MAX() keeps the duration non-negative if the server clock moved back.
      `UPDATE entries SET ended_at = MAX(?, started_at)
       WHERE employee_id = ? AND ended_at IS NULL RETURNING id`,
    ),
    getEntry: db.prepare(`
      SELECT en.*, em.name AS employee_name
      FROM entries en JOIN employees em ON em.id = en.employee_id
      WHERE en.id = ?`),
    reportEntries: db.prepare(`
      SELECT en.*, em.name AS employee_name
      FROM entries en JOIN employees em ON em.id = en.employee_id
      WHERE ${OVERLAPS_PERIOD} AND (:employeeId IS NULL OR em.id = :employeeId)
      ORDER BY en.started_at`),
    // MAX(0, ...) keeps a share non-negative if the server clock moved back
    // while a timer runs. For an employee without entries the share is NULL,
    // SUM skips it and COALESCE gives 0.
    reportTotals: db.prepare(`
      SELECT em.id AS employee_id, em.name,
             COALESCE(SUM(MAX(0,
               MIN(COALESCE(en.ended_at, :now), :to) - MAX(en.started_at, :from)
             )), 0) AS total_ms
      FROM employees em
      LEFT JOIN entries en ON en.employee_id = em.id AND ${OVERLAPS_PERIOD}
      WHERE :employeeId IS NULL OR em.id = :employeeId
      GROUP BY em.id
      ORDER BY em.name_key`),
  };

  function requireEmployee(id) {
    const employee = Number.isInteger(id) ? stmt.getEmployee.get(id) : undefined;
    if (!employee) throw new AppError(404, 'Сотрудник не найден');
    return employee;
  }

  function requireText(value, message, maxLength) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) throw new AppError(400, message);
    if (text.length > maxLength) throw new AppError(400, `Не больше ${maxLength} символов`);
    return text;
  }

  return {
    listEmployees() {
      return stmt.listEmployees.all().map((row) => ({
        id: row.id,
        name: row.name,
        activeEntry: row.entry_id
          ? { id: row.entry_id, description: row.description, startedAt: row.started_at }
          : null,
      }));
    },

    createEmployee(name, now) {
      const clean = requireText(name, 'Введите имя сотрудника', MAX_NAME).replace(/\s+/g, ' ');
      try {
        const key = clean.toLocaleLowerCase('ru');
        const { lastInsertRowid } = stmt.insertEmployee.run(clean, key, now);
        return { id: Number(lastInsertRowid), name: clean, activeEntry: null };
      } catch (err) {
        if (isUniqueViolation(err)) throw new AppError(409, 'Такой сотрудник уже есть');
        throw err;
      }
    },

    startTimer(employeeId, description, now) {
      requireEmployee(employeeId);
      const clean = requireText(description, 'Введите описание задачи', MAX_DESCRIPTION);
      try {
        const { lastInsertRowid } = stmt.insertEntry.run(employeeId, clean, now);
        return toEntry(stmt.getEntry.get(lastInsertRowid));
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new AppError(409, 'Таймер уже запущен. Сначала остановите его.');
        }
        throw err;
      }
    },

    stopTimer(employeeId, now) {
      requireEmployee(employeeId);
      const row = stmt.stopActive.get(now, employeeId);
      if (!row) throw new AppError(409, 'Нет запущенного таймера');
      return toEntry(stmt.getEntry.get(row.id));
    },

    // Returns entries that overlap [from, to) and the time inside the period
    // for each employee. An active entry counts up to `now`.
    // `employeeId` is optional. An unknown id gives 404, the same as the timer endpoints.
    report({ from, to, employeeId }, now) {
      if (employeeId !== undefined) requireEmployee(employeeId);
      const params = { from, to, now, employeeId: employeeId ?? null };

      const entries = stmt.reportEntries.all(params).map(toEntry);
      const totals = stmt.reportTotals.all(params).map((row) => ({
        employeeId: row.employee_id,
        name: row.name,
        totalMs: row.total_ms,
      }));
      return { entries, totals };
    },
  };
}
