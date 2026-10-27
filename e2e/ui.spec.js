import { test, expect } from '@playwright/test';

// All tests share one database. Each test creates employees with its own
// unique names, so the order of the tests does not matter.
let counter = 0;
function uniqueName(base) {
  counter += 1;
  return `${base} ${Date.now() % 100000}-${counter}`;
}

async function addEmployee(page, name) {
  await page.getByLabel('Имя сотрудника').fill(name);
  await page.getByRole('button', { name: 'Добавить' }).click();
  await expect(employeeRow(page, name)).toBeVisible();
}

function employeeRow(page, name) {
  return page.locator('#employees li').filter({ hasText: name });
}

async function employeeId(request, name) {
  const list = await (await request.get('/api/employees')).json();
  return list.find((e) => e.name === name).id;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('пустой отчёт показывает подсказку вместо таблицы', async ({ page }) => {
  await page.getByLabel('С', { exact: true }).fill('2001-01-01');
  await page.getByLabel('По', { exact: true }).fill('2001-01-07');
  await page.getByRole('button', { name: 'Показать' }).click();

  await expect(page.getByText('Нет записей за период.')).toBeVisible();
  await expect(page.locator('#entries-table')).toBeHidden();
});

test('новый сотрудник появляется в списке и в фильтре отчёта', async ({ page }) => {
  const name = uniqueName('Анна Тестова');
  await addEmployee(page, name);

  await expect(page.getByLabel('Имя сотрудника')).toHaveValue('');
  await expect(page.locator('#report-employee').locator('option', { hasText: name })).toHaveCount(1);
});

test('дубль имени показывает ошибку рядом с полем', async ({ page }) => {
  const name = uniqueName('Борис Пример');
  await addEmployee(page, name);
  await page.getByLabel('Имя сотрудника').fill(name.toUpperCase());
  await page.getByRole('button', { name: 'Добавить' }).click();

  const field = page.getByLabel('Имя сотрудника');
  await expect(page.locator('#employee-error')).toHaveText('Такой сотрудник уже есть');
  await expect(field).toHaveAttribute('aria-describedby', 'employee-error');
});

test('двойная отправка формы создаёт одного сотрудника без ошибки', async ({ page }) => {
  const name = uniqueName('Вера Образцова');
  await page.getByLabel('Имя сотрудника').fill(name);
  await page.locator('#employee-form').evaluate((form) => {
    form.requestSubmit();
    form.requestSubmit();
  });

  await expect(employeeRow(page, name)).toHaveCount(1);
  await expect(page.locator('#employee-error')).toHaveText('');
});

test('старт и стоп таймера: счётчик, статус и запись в отчёте', async ({ page }) => {
  const name = uniqueName('Глеб Новиков');
  const task = uniqueName('Вёрстка формы');
  await addEmployee(page, name);
  const row = employeeRow(page, name);

  await row.getByLabel('Задача').fill(task);
  await row.getByRole('button', { name: 'Старт' }).click();

  await expect(row.getByRole('button', { name: 'Стоп' })).toBeVisible();
  await expect(page.locator('#timer-status')).toHaveText(`Таймер запущен: ${name}, ${task}`);
  // The counter runs: after a second it no longer shows zero.
  await expect(row.locator('.elapsed')).not.toHaveText('0:00:00', { timeout: 3000 });

  const entry = page.locator('#entries tr').filter({ hasText: task });
  await expect(entry).toContainText('идёт');

  await row.getByRole('button', { name: 'Стоп' }).click();
  await expect(row.getByRole('button', { name: 'Старт' })).toBeVisible();
  await expect(page.locator('#timer-status')).toContainText(`Таймер остановлен: ${name}`);
  await expect(entry).not.toContainText('идёт');
  await expect(page.locator('#totals tr').filter({ hasText: name })).not.toContainText('0:00:00');
});

test('повторный старт со старой страницы: ошибка и кнопка «Стоп»', async ({ page, request }) => {
  const name = uniqueName('Дарья Пробная');
  await addEmployee(page, name);
  const row = employeeRow(page, name);

  // Another tab starts the timer. This page still shows the "Старт" button.
  const id = await employeeId(request, name);
  await request.post(`/api/employees/${id}/timer/start`, { data: { description: 'Из другой вкладки' } });

  await row.getByLabel('Задача').fill('Повторный запуск');
  await row.getByRole('button', { name: 'Старт' }).click();

  await expect(row.getByRole('alert')).toHaveText('Таймер уже запущен. Сначала остановите его.');
  await expect(row.getByRole('button', { name: 'Стоп' })).toBeVisible();
  await expect(row).toContainText('Из другой вкладки');

  await row.getByRole('button', { name: 'Стоп' }).click();
  await expect(row.getByRole('button', { name: 'Старт' })).toBeVisible();
});

test('таймер из другой вкладки появляется без перезагрузки', async ({ page, request }) => {
  await page.clock.install();
  await page.goto('/');
  const name = uniqueName('Егор Опытный');
  await addEmployee(page, name);
  const row = employeeRow(page, name);

  const id = await employeeId(request, name);
  await request.post(`/api/employees/${id}/timer/start`, { data: { description: 'Опрос' } });
  await expect(row.getByRole('button', { name: 'Старт' })).toBeVisible();

  // The page polls every 30 seconds. The fake clock skips the wait.
  await page.clock.runFor(31_000);
  await expect(row.getByRole('button', { name: 'Стоп' })).toBeVisible();

  await request.post(`/api/employees/${id}/timer/stop`);
});

test('текст в поле задачи не пропадает при обновлении списка', async ({ page }) => {
  const first = uniqueName('Жанна Первая');
  const second = uniqueName('Захар Второй');
  await addEmployee(page, first);
  await addEmployee(page, second);

  await employeeRow(page, second).getByLabel('Задача').fill('Черновик');
  // A start of another employee's timer re-renders the whole list.
  await employeeRow(page, first).getByLabel('Задача').fill('Задача');
  await employeeRow(page, first).getByRole('button', { name: 'Старт' }).click();
  await expect(employeeRow(page, first).getByRole('button', { name: 'Стоп' })).toBeVisible();

  await expect(employeeRow(page, second).getByLabel('Задача')).toHaveValue('Черновик');
  await employeeRow(page, first).getByRole('button', { name: 'Стоп' }).click();
});

test('счётчик считает по часам сервера, а не браузера', async ({ page, request }) => {
  const name = uniqueName('Илья Часовой');
  await addEmployee(page, name);
  const id = await employeeId(request, name);
  await request.post(`/api/employees/${id}/timer/start`, { data: { description: 'Сдвиг часов' } });

  // The server clock is 2 minutes ahead of the browser.
  await page.route('**/api/**', async (route) => {
    const response = await route.fetch();
    const serverTime = Number(response.headers()['x-server-time']) + 2 * 60 * 1000;
    await route.fulfill({ response, headers: { ...response.headers(), 'x-server-time': String(serverTime) } });
  });
  await page.reload();

  await expect(employeeRow(page, name).locator('.elapsed')).toHaveText(/^0:02:0\d$/);
  await page.unroute('**/api/**');
  await request.post(`/api/employees/${id}/timer/stop`);
});

test('ошибка первой загрузки видна на странице', async ({ page }) => {
  await page.route('**/api/employees', (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Сбой сервера"}' }));
  await page.reload();

  await expect(page.locator('#employee-error')).toHaveText('Не удалось загрузить данные: Сбой сервера');
});

test('на телефоне страница не прокручивается вбок', async ({ page, request }) => {
  // A long entry in the current week makes the report table wide.
  const name = uniqueName('Константин Длинноименный');
  await addEmployee(page, name);
  const id = await employeeId(request, name);
  await request.post(`/api/employees/${id}/timer/start`, { data: { description: 'Исправление бага в корзине заказа' } });
  await request.post(`/api/employees/${id}/timer/stop`);

  await page.setViewportSize({ width: 375, height: 800 });
  await page.reload();
  await expect(page.locator('#entries tr').first()).toBeVisible();

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('кнопки и поля не ниже 44 пикселей', async ({ page }) => {
  await addEmployee(page, uniqueName('Лев Касательный'));
  const heights = await page.locator('button, input, select').evaluateAll((nodes) =>
    nodes.map((n) => Math.round(n.getBoundingClientRect().height)));
  expect(Math.min(...heights)).toBeGreaterThanOrEqual(44);
});
