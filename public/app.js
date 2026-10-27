const $ = (id) => document.getElementById(id);

const POLL_MS = 30 * 1000;
const ERROR_VISIBLE_MS = 8 * 1000;

// Difference between the server clock and the browser clock. Live counters use
// server time, so a wrong browser clock does not change the durations.
let clockOffset = 0;
const serverNow = () => Date.now() + clockOffset;

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const serverTime = Number(res.headers.get('X-Server-Time'));
  if (serverTime) clockOffset = serverTime - Date.now();
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `Ошибка ${res.status}`);
  return data;
}

function el(tag, { dataset, ...props } = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  // `dataset` is a read-only property, so Object.assign cannot set it.
  Object.assign(node.dataset, dataset);
  node.append(...children);
  return node;
}

function formatDuration(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
  const s = String(totalSec % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

const dateTime = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short' });

// Value of <input type="date"> in the local time zone.
function toDateInput(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// 'YYYY-MM-DD' -> local midnight of that day.
function localMidnight(value) {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/* ---------- Employees ---------- */

let employees = [];
let employeesJson = '';
// A timer error waits here until the next render of the list shows it once.
const timerErrors = new Map();
// Unsent task descriptions. They survive a re-render of the list.
const drafts = new Map();

// Polling calls this without `force`: it re-renders only when the data changed.
async function loadEmployees({ force = false } = {}) {
  const fresh = await api('GET', '/api/employees');
  const json = JSON.stringify(fresh);
  if (!force && json === employeesJson) return;
  employees = fresh;
  employeesJson = json;
  renderEmployees();
  renderEmployeeFilter();
}

function renderEmployees() {
  const list = $('employees');
  list.replaceChildren(...employees.map(renderEmployee));
  $('employees-empty').hidden = employees.length > 0;
  tickTimers();
}

function renderEmployee(emp) {
  const errorId = `timer-error-${emp.id}`;
  const error = el('p', { className: 'error', role: 'alert', id: errorId });
  const message = timerErrors.get(emp.id);
  if (message) {
    timerErrors.delete(emp.id);
    error.textContent = message;
    setTimeout(() => { error.textContent = ''; }, ERROR_VISIBLE_MS);
  }
  const item = el('li', {}, el('div', { className: 'name', textContent: emp.name }));

  if (emp.activeEntry) {
    const stop = el('button', { type: 'button', className: 'stop', textContent: 'Стоп' });
    stop.setAttribute('aria-describedby', errorId);
    stop.addEventListener('click', () => timerAction(stop, emp, 'stop'));
    item.append(
      el('div', { className: 'running' },
        el('span', { textContent: emp.activeEntry.description }),
        el('span', { className: 'elapsed', dataset: { startedAt: emp.activeEntry.startedAt } }),
        stop),
      error,
    );
  } else {
    const input = el('input', {
      placeholder: 'Описание задачи',
      maxLength: 200,
      required: true,
      value: drafts.get(emp.id) ?? '',
    });
    input.setAttribute('aria-describedby', errorId);
    input.addEventListener('input', () => drafts.set(emp.id, input.value));
    const start = el('button', { type: 'submit', textContent: 'Старт' });
    const form = el('form', { className: 'row' },
      el('label', { className: 'grow' }, 'Задача', input),
      start);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      timerAction(start, emp, 'start', { description: input.value });
    });
    item.append(form, error);
  }
  return item;
}

async function timerAction(button, employee, action, body) {
  const employeeId = employee.id;
  button.disabled = true;
  try {
    const entry = await api('POST', `/api/employees/${employeeId}/timer/${action}`, body);
    if (action === 'start') drafts.delete(employeeId);
    // One complete phrase for screen readers, without moving focus.
    $('timer-status').textContent = action === 'start'
      ? `Таймер запущен: ${employee.name}, ${entry.description}`
      : `Таймер остановлен: ${employee.name}, ${formatDuration(entry.endedAt - entry.startedAt)}`;
  } catch (err) {
    // The page may be out of date, for example after a start in another tab.
    // Keep the message and reload the real state below.
    timerErrors.set(employeeId, err.message);
  }
  try {
    await Promise.all([loadEmployees({ force: true }), loadReport()]);
  } catch (err) {
    button.disabled = false;
    $('employee-error').textContent = err.message;
  }
}

// Updates every live value once a second: running timers in the employee list
// and in the report, and report totals of employees with a running timer.
function tickTimers() {
  const now = serverNow();
  for (const node of document.querySelectorAll('[data-started-at]')) {
    node.textContent = formatDuration(now - Number(node.dataset.startedAt));
  }
  for (const node of document.querySelectorAll('[data-live-base]')) {
    const { liveBase, liveSince, liveUntil } = node.dataset;
    const extra = Math.max(0, Math.min(now, Number(liveUntil)) - Number(liveSince));
    node.textContent = formatDuration(Number(liveBase) + extra);
  }
}

$('employee-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('employee-name');
  const button = event.submitter ?? $('employee-form').querySelector('button');
  // A second Enter or double click must not send the same name again.
  if (button.disabled) return;
  button.disabled = true;
  $('employee-error').textContent = '';
  try {
    await api('POST', '/api/employees', { name: input.value });
    input.value = '';
    await Promise.all([loadEmployees(), loadReport()]);
  } catch (err) {
    $('employee-error').textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

/* ---------- Report ---------- */

function renderEmployeeFilter() {
  const select = $('report-employee');
  const current = select.value;
  select.replaceChildren(
    el('option', { value: '', textContent: 'Все' }),
    ...employees.map((e) => el('option', { value: String(e.id), textContent: e.name })),
  );
  select.value = employees.some((e) => String(e.id) === current) ? current : '';
}

function setCurrentWeek() {
  const today = new Date();
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - ((today.getDay() + 6) % 7));
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
  $('report-from').value = toDateInput(monday);
  $('report-to').value = toDateInput(sunday);
}

let reportRequest = 0;

async function loadReport() {
  $('report-error').textContent = '';
  const fromValue = $('report-from').value;
  const toValue = $('report-to').value;
  if (!fromValue || !toValue) {
    $('report-error').textContent = 'Выберите обе даты';
    return;
  }
  // "По" includes the whole last day: the period ends at the next local midnight.
  const from = localMidnight(fromValue);
  const to = localMidnight(toValue);
  to.setDate(to.getDate() + 1);

  const query = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
  const employeeId = $('report-employee').value;
  if (employeeId) query.set('employeeId', employeeId);

  // A slow old response must not replace a newer one.
  const request = ++reportRequest;
  try {
    const report = await api('GET', `/api/report?${query}`);
    if (request === reportRequest) renderReport(report, to.getTime());
  } catch (err) {
    if (request === reportRequest) $('report-error').textContent = err.message;
  }
}

function renderReport({ entries, totals }, periodEnd) {
  const now = serverNow();
  const running = new Set(entries.filter((e) => !e.endedAt).map((e) => e.employeeId));

  $('totals').replaceChildren(...totals.map((t) =>
    el('tr', {},
      el('td', { textContent: t.name }),
      el('td', {
        className: 'num',
        textContent: formatDuration(t.totalMs),
        // The server counted a running timer up to `now`. The page adds the
        // time after that, but not past the end of the period.
        dataset: running.has(t.employeeId)
          ? { liveBase: t.totalMs, liveSince: now, liveUntil: periodEnd }
          : {},
      }))));

  $('entries').replaceChildren(...entries.map((e) =>
    el('tr', {},
      el('td', { textContent: e.employeeName }),
      el('td', { textContent: e.description }),
      el('td', { className: 'date', textContent: dateTime.format(e.startedAt) }),
      el('td', { className: 'date', textContent: e.endedAt ? dateTime.format(e.endedAt) : 'идёт' }),
      el('td', {
        className: 'num',
        textContent: formatDuration((e.endedAt ?? now) - e.startedAt),
        // A running entry gets the live counter, the same as in the employee list.
        dataset: e.endedAt ? {} : { startedAt: e.startedAt },
      }))));

  $('entries-empty').hidden = entries.length > 0;
  $('entries-table').hidden = entries.length === 0;
}

$('report-form').addEventListener('submit', (event) => {
  event.preventDefault();
  loadReport();
});
$('report-employee').addEventListener('change', loadReport);

/* ---------- Start ---------- */

setCurrentWeek();
setInterval(tickTimers, 1000);
// Changes from other tabs and other people appear without a reload.
setInterval(() => {
  loadEmployees().catch(() => {});
  loadReport();
}, POLL_MS);

try {
  await Promise.all([loadEmployees(), loadReport()]);
} catch (err) {
  $('employee-error').textContent = `Не удалось загрузить данные: ${err.message}`;
}
