// Fills an empty database with fictional employees and entries for the last few days.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDb, DEFAULT_DB_PATH } from '../src/db.js';
import { createRepo } from '../src/repo.js';

const dbPath = process.env.DB_PATH || DEFAULT_DB_PATH;
mkdirSync(dirname(dbPath), { recursive: true });
const db = openDb(dbPath);
const repo = createRepo(db);

if (repo.listEmployees().length > 0) {
  console.log('В базе уже есть сотрудники. Seed пропущен.');
  process.exit(0);
}

const HOUR = 60 * 60 * 1000;
const tasks = {
  'Анна Тестова': ['Вёрстка формы заказа', 'Код-ревью', 'Исправление бага в корзине'],
  'Борис Пример': ['Настройка CI', 'Обновление зависимостей'],
  'Вера Образцова': ['Созвон с заказчиком', 'Описание требований', 'Тест-кейсы'],
};

const today = new Date();

for (const [name, list] of Object.entries(tasks)) {
  const emp = repo.createEmployee(name, Date.now());
  for (let daysAgo = 3; daysAgo >= 1; daysAgo -= 1) {
    // 10:00 local time. Date arithmetic, not 24-hour steps, so a DST change does not shift it.
    let t = new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysAgo, 10).getTime();
    for (const description of list) {
      repo.startTimer(emp.id, description, t);
      t += HOUR + Math.round(Math.random() * HOUR);
      repo.stopTimer(emp.id, t);
      t += 15 * 60 * 1000;
    }
  }
}

console.log(`Добавлено сотрудников: ${Object.keys(tasks).length}. База: ${dbPath}`);
db.close();
