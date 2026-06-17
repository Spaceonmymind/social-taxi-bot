/**
 * server.js — HTTP-сервер для мини-приложения социального такси (MAX Bot)
 * ─────────────────────────────────────────────────────────────────────────────
 * НАЗНАЧЕНИЕ:
 *   Принимает запросы из index.html (мини-приложение MAX) и передаёт их
 *   в bot.js для сохранения в базу и рассылки уведомлений через MAX Bot API.
 *
 * КАК ЗАПУСКАТЬ:
 *   node server.js          — запуск сервера
 *   node bot.js             — запуск бота (отдельный процесс)
 *   Оба процесса должны работать одновременно на сервере.
 *
 * ПЕРЕМЕННЫЕ ОКРУЖЕНИЯ (.env):
 *   PORT         — порт сервера (по умолчанию 3000)
 *   ADMIN_TOKEN  — секретный токен для admin-эндпоинтов (придумать самостоятельно)
 *
 * БЕЗОПАСНОСТЬ ADMIN-ЭНДПОИНТОВ:
 *   Все /api/admin/* требуют заголовок: X-Admin-Token: <значение из .env>
 *   Без токена возвращается 401 Unauthorized.
 *
 * ДВОЙНАЯ ПРОВЕРКА isCarAvailable:
 *   server.js проверяет доступность машин до создания заявки (строка ~137).
 *   bot.js::handleNewRequest делает то же внутри себя как дополнительная страховка.
 *   Это намеренная избыточность — оба места можно оставить как есть.
 *
 * ENDPOINTS:
 *   POST /api/submit-request    — создание заявки из мини-приложения
 *   POST /api/cancel-request    — отмена заявки пользователем
 *   GET  /api/my-requests       — заявки конкретного пользователя (?userId=...)
 *   POST /api/submit-feedback   — отзыв и оценка после поездки
 *   GET  /api/admin/requests    — все заявки [X-Admin-Token]
 *   POST /api/admin/status      — сменить статус заявки [X-Admin-Token]
 *   POST /api/admin/cost        — указать стоимость поездки [X-Admin-Token]
 *   POST /api/admin/car         — назначить автомобиль [X-Admin-Token]
 *   POST /api/admin/comment     — добавить комментарий оператора [X-Admin-Token]
 *   GET  /api/admin/feedbacks   — все отзывы [X-Admin-Token]
 *   GET  /health                — проверка работоспособности сервера
 */

import http from 'http';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import {
  handleNewRequest,
  handleFeedback,
  cancelRequest,
  getRequestsByUser,
  getAllRequests,
  updateRequest,
  getRecentFeedbacks,
  isCarAvailable,
} from './bot.js';

const PORT = process.env.PORT || 3000;
const __dirname = dirname(fileURLToPath(import.meta.url));
const MINIAPP_FILE = join(__dirname, 'miniapp', 'index.html');

// ─────────────────────────────────────────────────────────────────────────────
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ─────────────────────────────────────────────────────────────────────────────

// Разрешаем CORS — мини-приложение (index.html) может быть опубликовано
// на другом домене (например GitHub Pages), поэтому браузер требует CORS-заголовки.
// '*' означает «разрешить с любого домена» — для продакшена можно ограничить
// конкретным адресом MINI_APP_URL из .env
function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Token');
}

// Отправить JSON-ответ с нужным статус-кодом
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function html(res, status, content) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(content);
}

// Прочитать тело POST-запроса и распарсить JSON
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch(e) { reject(new Error('Невалидный JSON')); }
    });
    req.on('error', reject);
  });
}

// Распарсить query-параметры из URL (?userId=123&status=new → { userId: '123', status: 'new' })
function parseQuery(url) {
  const idx = url.indexOf('?');
  if (idx === -1) return {};
  return Object.fromEntries(new URLSearchParams(url.slice(idx + 1)));
}

// Проверить, что запрос пришёл с правильным admin-токеном (заголовок X-Admin-Token)
// ADMIN_TOKEN задаётся в .env — любая строка, которую вы придумываете сами
function isAdminRequest(req) {
  const token = req.headers['x-admin-token'];
  return token && token === process.env.ADMIN_TOKEN;
}

// ─────────────────────────────────────────────────────────────────────────────
// СЕРВЕР
// ─────────────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  setCORS(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = req.url.split('?')[0];

  if (req.method === 'GET' && (url === '/' || url === '/miniapp' || url === '/miniapp/index.html')) {
    try {
      return html(res, 200, readFileSync(MINIAPP_FILE, 'utf8'));
    } catch(e) {
      return html(res, 500, 'miniapp/index.html not found');
    }
  }

  // ── POST /api/submit-request ──────────────────────────────────────────────
  if (req.method === 'POST' && url === '/api/submit-request') {
    try {
      const data = await readBody(req);

      // Обязательные поля
      const required = ['fullname', 'phone', 'address', 'category', 'destCategory', 'destInstitution', 'destAddress', 'tripDate', 'tripTime'];
      const missing = required.filter(f => !data[f]);
      if (missing.length) {
        return json(res, 400, { error: `Не заполнены обязательные поля: ${missing.join(', ')}` });
      }

      // Валидация телефона РФ
      const phone = data.phone.replace(/\D/g, '');
      if (phone.length !== 11 || !phone.startsWith('7')) {
        return json(res, 400, { error: 'Некорректный номер телефона' });
      }

      // Валидация ФИО — минимум 2 слова
      const nameParts = data.fullname.trim().split(/\s+/).filter(Boolean);
      if (nameParts.length < 2) {
        return json(res, 400, { error: 'Укажите полное ФИО (минимум два слова)' });
      }

      // Валидация даты — минимум 3 суток вперёд и только будни (Пн–Пт)
      if (data.tripDate) {
        const sel = new Date(data.tripDate + 'T00:00:00');
        const min = new Date();
        min.setHours(0, 0, 0, 0);
        min.setDate(min.getDate() + 3);
        if (sel < min) {
          return json(res, 400, { error: 'Заявка должна быть подана не менее чем за 3 суток до поездки' });
        }
        const dow = sel.getDay(); // 0=Вс, 1=Пн ... 6=Сб
        if (dow === 0 || dow === 6) {
          return json(res, 400, { error: 'Поездки в выходные дни недоступны (Сб, Вс)' });
        }
      }

      // Валидация времени — рабочие часы:
      //   Пн–Чт: 08:00–17:00 (последний допустимый слот — ровно 17:00)
      //   Пт:    08:00–16:00 (последний допустимый слот — ровно 16:00)
      // ВАЖНО: используем >= чтобы граничное значение (17:00 / 16:00) проходило валидацию.
      // Было: mins > endMins — это неверно, т.к. ровно 17:00 = 1020 мин не пропускалось.
      if (data.tripDate && data.tripTime) {
        const dow = new Date(data.tripDate + 'T00:00:00').getDay();
        const [h, m] = data.tripTime.split(':').map(Number);
        const mins = h * 60 + m;
        const endMins = dow === 5 ? 16 * 60 : 17 * 60; // пятница — до 16:00, остальные — до 17:00
        if (mins < 8 * 60 || mins >= endMins) {
          return json(res, 400, { error: 'Время поездки должно быть в рабочие часы (Пн–Чт 08:00–17:00, Пт 08:00–16:00)' });
        }
      }

      // Проверка занятости автомобилей (оба авто уже заняты на эту дату)
      // Примечание: bot.js::handleNewRequest делает ту же проверку внутри себя —
      // это намеренная двойная страховка, оба места можно оставить.
      if (data.tripDate && !isCarAvailable(data.tripDate)) {
        return json(res, 409, { error: 'На выбранную дату оба автомобиля уже заняты. Выберите другую дату.' });
      }

      const senderUserId = data.senderUserId || null;

      // Предупреждение: если senderUserId не передан, пользователь не получит уведомление
      // об изменении статуса заявки. Это произойдёт если форма открыта не через бот MAX,
      // а напрямую по ссылке. В продакшене такой сценарий нежелателен.
      if (!senderUserId) {
        console.warn(`⚠️  Заявка от ${data.fullname} создана без senderUserId — уведомления не будут доставлены`);
      }

      const cleanData = { ...data };
      delete cleanData.senderUserId;

      const request = await handleNewRequest(cleanData, senderUserId);

      console.log(`📥 Новая заявка #${request.id.slice(-6).toUpperCase()} — ${data.fullname}, ${data.tripDate}`);
      return json(res, 200, { ok: true, requestId: request.id });

    } catch(e) {
      console.error('Ошибка создания заявки:', e.message);
      if (e.message.includes('автомобил')) return json(res, 409, { error: e.message });
      return json(res, 500, { error: e.message || 'Внутренняя ошибка сервера' });
    }
  }

  // ── POST /api/cancel-request ──────────────────────────────────────────────
  // Отмена заявки пользователем из мини-приложения (экран «Мои заявки»).
  // Отмена возможна только не позднее 3 часов до поездки — логика в bot.js::cancelRequest.
  // Требует: { requestId, userId }
  if (req.method === 'POST' && url === '/api/cancel-request') {
    try {
      const data = await readBody(req);
      if (!data.requestId) return json(res, 400, { error: 'Не указан requestId' });
      if (!data.userId)    return json(res, 400, { error: 'Не указан userId' });

      // userId передаётся как строка из WebApp, cancelRequest сравнивает со строкой
      const result = cancelRequest(data.requestId, String(data.userId));
      if (!result.ok) return json(res, 400, { error: result.error });

      console.log(`🚫 Заявка #${result.req.id.slice(-6).toUpperCase()} отменена пользователем`);
      return json(res, 200, { ok: true });

    } catch(e) {
      console.error('Ошибка отмены заявки:', e.message);
      return json(res, 500, { error: 'Внутренняя ошибка сервера' });
    }
  }

  // ── GET /api/my-requests ──────────────────────────────────────────────────
  // Возвращает список заявок конкретного пользователя для экрана «Мои заявки».
  // userId — числовой ID пользователя MAX, передаётся как строка в query-параметре.
  if (req.method === 'GET' && url === '/api/my-requests') {
    try {
      const query = parseQuery(req.url);
      if (!query.userId) return json(res, 400, { error: 'Не указан userId' });
      // userId хранится как строка — передаём строку
      const requests = getRequestsByUser(String(query.userId));
      return json(res, 200, { ok: true, requests });

    } catch(e) {
      console.error('Ошибка получения заявок:', e.message);
      return json(res, 500, { error: 'Внутренняя ошибка сервера' });
    }
  }

  // ── POST /api/submit-feedback ─────────────────────────────────────────────
  // Принимает отзыв пользователя после поездки: оценка (1–5), текст, авто, стоимость.
  // Сохраняется в отдельный файл (FEEDBACK_FILE из .env) и рассылается операторам.
  if (req.method === 'POST' && url === '/api/submit-feedback') {
    try {
      const data = await readBody(req);
      if (!data.rating || !data.text) {
        return json(res, 400, { error: 'Не заполнены обязательные поля (rating, text)' });
      }
      if (data.rating < 1 || data.rating > 5) {
        return json(res, 400, { error: 'Оценка должна быть от 1 до 5' });
      }
      const fb = await handleFeedback(data);
      return json(res, 200, { ok: true, feedbackId: fb.id });

    } catch(e) {
      console.error('Ошибка сохранения отзыва:', e.message);
      return json(res, 500, { error: 'Внутренняя ошибка сервера' });
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ADMIN ENDPOINTS — только для операторов
  // Все эндпоинты требуют заголовок: X-Admin-Token: <ADMIN_TOKEN из .env>
  // Обычно вызываются из bot.js при нажатии кнопок в чате оператора,
  // но могут вызываться и напрямую (например, через Postman для отладки).
  // ══════════════════════════════════════════════════════════════════════════

  // ── GET /api/admin/requests ───────────────────────────────────────────────
  // Список всех заявок с фильтрацией по статусу и дате.
  // Параметры: ?status=new&date=2025-06-15 (оба необязательны)
  if (req.method === 'GET' && url === '/api/admin/requests') {
    if (!isAdminRequest(req)) return json(res, 401, { error: 'Unauthorized' });
    try {
      const query = parseQuery(req.url);
      let requests = getAllRequests();
      if (query.status) requests = requests.filter(r => r.status === query.status);
      if (query.date)   requests = requests.filter(r => r.tripDate === query.date);
      return json(res, 200, { ok: true, requests, total: requests.length });

    } catch(e) {
      return json(res, 500, { error: 'Внутренняя ошибка сервера' });
    }
  }

  // ── POST /api/admin/status ────────────────────────────────────────────────
  // Смена статуса заявки. Допустимые значения: new, confirmed, cancelled, completed, rejected.
  // При смене статуса через bot.js пользователю автоматически приходит уведомление.
  if (req.method === 'POST' && url === '/api/admin/status') {
    if (!isAdminRequest(req)) return json(res, 401, { error: 'Unauthorized' });
    try {
      const data = await readBody(req);
      if (!data.requestId || !data.status) {
        return json(res, 400, { error: 'Необходимы requestId и status' });
      }
      const allowed = ['new', 'confirmed', 'cancelled', 'completed', 'rejected'];
      if (!allowed.includes(data.status)) {
        return json(res, 400, { error: 'Недопустимый статус: ' + data.status });
      }
      const updated = updateRequest(data.requestId, { status: data.status });
      if (!updated) return json(res, 404, { error: 'Заявка не найдена' });
      return json(res, 200, { ok: true, request: updated });

    } catch(e) {
      return json(res, 500, { error: 'Внутренняя ошибка сервера' });
    }
  }

  // ── POST /api/admin/cost ──────────────────────────────────────────────────
  // Указать стоимость поездки (в рублях). Вызывается оператором через бот.
  // Стоимость: по Кургану 119–342 руб., +22 руб./км за городом.
  if (req.method === 'POST' && url === '/api/admin/cost') {
    if (!isAdminRequest(req)) return json(res, 401, { error: 'Unauthorized' });
    try {
      const data = await readBody(req);
      if (!data.requestId || data.cost === undefined) {
        return json(res, 400, { error: 'Необходимы requestId и cost' });
      }
      const cost = Number(data.cost);
      if (isNaN(cost) || cost < 0) return json(res, 400, { error: 'Некорректная стоимость' });
      const updated = updateRequest(data.requestId, { cost });
      if (!updated) return json(res, 404, { error: 'Заявка не найдена' });
      return json(res, 200, { ok: true, request: updated });

    } catch(e) {
      return json(res, 500, { error: 'Внутренняя ошибка сервера' });
    }
  }

  // ── POST /api/admin/car ───────────────────────────────────────────────────
  // Назначить автомобиль на заявку. Оператор вводит номер и марку вручную.
  // Всего 2 автомобиля (ограничение в isCarAvailable). Пример: «М976ММ белая LADA Granta»
  if (req.method === 'POST' && url === '/api/admin/car') {
    if (!isAdminRequest(req)) return json(res, 401, { error: 'Unauthorized' });
    try {
      const data = await readBody(req);
      if (!data.requestId || !data.car) {
        return json(res, 400, { error: 'Необходимы requestId и car' });
      }
      const updated = updateRequest(data.requestId, { car: data.car.trim() });
      if (!updated) return json(res, 404, { error: 'Заявка не найдена' });
      return json(res, 200, { ok: true, request: updated });

    } catch(e) {
      return json(res, 500, { error: 'Внутренняя ошибка сервера' });
    }
  }

  // ── POST /api/admin/comment ───────────────────────────────────────────────
  // Добавить внутренний комментарий оператора к заявке (виден только в боте оператора).
  if (req.method === 'POST' && url === '/api/admin/comment') {
    if (!isAdminRequest(req)) return json(res, 401, { error: 'Unauthorized' });
    try {
      const data = await readBody(req);
      if (!data.requestId || !data.comment) {
        return json(res, 400, { error: 'Необходимы requestId и comment' });
      }
      const updated = updateRequest(data.requestId, { operatorComment: data.comment });
      if (!updated) return json(res, 404, { error: 'Заявка не найдена' });
      return json(res, 200, { ok: true, request: updated });

    } catch(e) {
      return json(res, 500, { error: 'Внутренняя ошибка сервера' });
    }
  }

  // ── GET /api/admin/feedbacks ──────────────────────────────────────────────
  // Список отзывов с подсчётом среднего рейтинга.
  // Параметры: ?limit=50 (по умолчанию 50 последних отзывов)
  if (req.method === 'GET' && url === '/api/admin/feedbacks') {
    if (!isAdminRequest(req)) return json(res, 401, { error: 'Unauthorized' });
    try {
      const query    = parseQuery(req.url);
      const limit    = parseInt(query.limit) || 50;
      const feedbacks = getRecentFeedbacks(limit);
      const avgRating = feedbacks.length
        ? (feedbacks.reduce((s, f) => s + (f.rating || 0), 0) / feedbacks.length).toFixed(1)
        : null;
      return json(res, 200, { ok: true, feedbacks, total: feedbacks.length, avgRating });

    } catch(e) {
      return json(res, 500, { error: 'Внутренняя ошибка сервера' });
    }
  }

  // ── GET /health ───────────────────────────────────────────────────────────
  // Простая проверка: если сервер отвечает {"status":"ok"} — он живой.
  // Используется для мониторинга (uptime-сервисы, балансировщики).
  if (req.method === 'GET' && url === '/health') {
    return json(res, 200, { status: 'ok', uptime: Math.floor(process.uptime()) });
  }

  // Неизвестный маршрут
  json(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`🌐 Сервер запущен на порту ${PORT}`);
  console.log(`   POST http://localhost:${PORT}/api/submit-request`);
  console.log(`   POST http://localhost:${PORT}/api/cancel-request`);
  console.log(`   GET  http://localhost:${PORT}/api/my-requests?userId=<id>`);
  console.log(`   POST http://localhost:${PORT}/api/submit-feedback`);
  console.log(`   GET  http://localhost:${PORT}/api/admin/requests  [X-Admin-Token]`);
  console.log(`   POST http://localhost:${PORT}/api/admin/status    [X-Admin-Token]`);
  console.log(`   POST http://localhost:${PORT}/api/admin/cost      [X-Admin-Token]`);
  console.log(`   POST http://localhost:${PORT}/api/admin/car       [X-Admin-Token]`);
  console.log(`   POST http://localhost:${PORT}/api/admin/comment   [X-Admin-Token]`);
  console.log(`   GET  http://localhost:${PORT}/api/admin/feedbacks [X-Admin-Token]`);
});
