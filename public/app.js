const $ = (id) => document.getElementById(id);

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
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
// Last timer error per employee id. It survives a re-render of the list.
const timerErrors = new Map();

async function loadEmployees() {
  employees = await api('GET', '/api/employees');
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
  const error = el('p', { className: 'error', role: 'alert', textContent: timerErrors.get(emp.id) ?? '' });
  const item = el('li', {}, el('div', { className: 'name', textContent: emp.name }));

  if (emp.activeEntry) {
    const stop = el('button', { type: 'button', className: 'stop', textContent: 'Стоп' });
    stop.addEventListener('click', () => timerAction(stop, emp.id, 'stop'));
    item.append(
      el('div', { className: 'running' },
        el('span', { textContent: emp.activeEntry.description }),
        el('span', { className: 'elapsed', dataset: { startedAt: emp.activeEntry.startedAt } }),
        stop),
      error,
    );
  } else {
    const input = el('input', { placeholder: 'Описание задачи', maxLength: 200, required: true });
    const start = el('button', { type: 'submit', textContent: 'Старт' });
    const form = el('form', { className: 'row' }, input, start);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      timerAction(start, emp.id, 'start', { description: input.value });
    });
    item.append(form, error);
  }
  return item;
}

async function timerAction(button, employeeId, action, body) {
  button.disabled = true;
  timerErrors.delete(employeeId);
  try {
    await api('POST', `/api/employees/${employeeId}/timer/${action}`, body);
  } catch (err) {
    // The page may be out of date, for example after a start in another tab.
    // Keep the message and reload the real state below.
    timerErrors.set(employeeId, err.message);
  }
  try {
    await Promise.all([loadEmployees(), loadReport()]);
  } catch (err) {
    button.disabled = false;
    $('employee-error').textContent = err.message;
  }
}

// Updates every running duration: in the employee list and in the report.
function tickTimers() {
  for (const node of document.querySelectorAll('[data-started-at]')) {
    node.textContent = formatDuration(Date.now() - Number(node.dataset.startedAt));
  }
}

$('employee-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('employee-name');
  $('employee-error').textContent = '';
  try {
    await api('POST', '/api/employees', { name: input.value });
    input.value = '';
    await Promise.all([loadEmployees(), loadReport()]);
  } catch (err) {
    $('employee-error').textContent = err.message;
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
    if (request === reportRequest) renderReport(report);
  } catch (err) {
    if (request === reportRequest) $('report-error').textContent = err.message;
  }
}

function renderReport({ entries, totals }) {
  $('totals').replaceChildren(...totals.map((t) =>
    el('tr', {},
      el('td', { textContent: t.name }),
      el('td', { className: 'num', textContent: formatDuration(t.totalMs) }))));

  $('entries').replaceChildren(...entries.map((e) =>
    el('tr', {},
      el('td', { textContent: e.employeeName }),
      el('td', { textContent: e.description }),
      el('td', { textContent: dateTime.format(e.startedAt) }),
      el('td', { textContent: e.endedAt ? dateTime.format(e.endedAt) : 'идёт' }),
      el('td', {
        className: 'num',
        textContent: formatDuration((e.endedAt ?? Date.now()) - e.startedAt),
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
// Totals of a running timer change over time. Refresh the report once a minute.
setInterval(() => {
  if (employees.some((e) => e.activeEntry)) loadReport();
}, 60 * 1000);

try {
  await Promise.all([loadEmployees(), loadReport()]);
} catch (err) {
  $('employee-error').textContent = `Не удалось загрузить данные: ${err.message}`;
}
