/**
 * bot.js — Бот социального такси (MAX Bot API)
 * ─────────────────────────────────────────────────────────────────────────────
 * АРХИТЕКТУРА:
 *   bot.js    — основной файл: бот, логика, база данных, уведомления
 *   server.js — HTTP-сервер, принимает POST /api/submit-request из index.html
 *               и вызывает handleNewRequest() / handleFeedback() из этого файла
 *   index.html — мини-приложение (форма заявки), открывается кнопкой в боте
 *
 * ФЛОУ ЗАЯВКИ:
 *   1. Пользователь открывает мини-приложение → заполняет форму → отправляет
 *   2. server.js принимает POST, вызывает handleNewRequest()
 *   3. Пользователю и всем операторам приходит уведомление в MAX
 *   4. Оператор в боте нажимает кнопки: назначить авто → указать стоимость → подтвердить
 *   5. Пользователю приходит финальное уведомление с данными автомобиля
 *
 * СТАТУСЫ ЗАЯВКИ:
 *   new        — только что создана, ждёт оператора
 *   confirmed  — оператор подтвердил
 *   completed  — поездка завершена
 *   cancelled  — отменена (пользователем или оператором)
 *   rejected   — отклонена оператором
 *
 * БАЗА ДАННЫХ:
 *   Хранится в JSON-файлах (requests.json, feedback.json).
 *   Для продакшена рекомендуется заменить на PostgreSQL или MongoDB.
 *
 * АВТОМОБИЛИ (2 шт.):
 *   Ограничение встроено в isCarAvailable() — не более 2 активных заявок на дату.
 *   Номера вводит оператор вручную через кнопку «Указать автомобиль».
 *
 * ПЕРЕМЕННЫЕ ОКРУЖЕНИЯ (.env):
 *   BOT_TOKEN    — токен бота из MAX Developer Portal
 *   ADMIN_IDS    — числовые ID операторов через запятую (узнать: @userinfobot в MAX)
 *   MINI_APP_URL — URL опубликованного index.html
 *   DB_FILE      — путь к файлу базы заявок (по умолчанию ./requests.json)
 *   FEEDBACK_FILE— путь к файлу отзывов (по умолчанию ./feedback.json)
 */

import { Bot, Keyboard } from '@maxhub/max-bot-api';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const bot = new Bot(process.env.BOT_TOKEN);

// ─────────────────────────────────────────────────────────────────────────────
// КОНФИГУРАЦИЯ
// ─────────────────────────────────────────────────────────────────────────────

const MINI_APP_URL = process.env.MINI_APP_URL || 'https://your-domain.ru/miniapp/';

const ADMIN_IDS = (process.env.ADMIN_IDS || '')
  .split(',')
  .map(id => parseInt(id.trim()))
  .filter(Boolean);

const DB_FILE       = process.env.DB_FILE       || './requests.json';
const FEEDBACK_FILE = process.env.FEEDBACK_FILE || './feedback.json';

// ─────────────────────────────────────────────────────────────────────────────
// БАЗА ДАННЫХ (JSON-файлы)
// ─────────────────────────────────────────────────────────────────────────────
// Вся база хранится в двух JSON-файлах на диске сервера.
// При каждом чтении/записи файл читается заново — это безопасно для малых
// объёмов, но при большой нагрузке стоит перейти на нормальную СУБД.

function loadDB() {
  if (!existsSync(DB_FILE)) return { requests: [] };
  try { return JSON.parse(readFileSync(DB_FILE, 'utf8')); }
  catch { return { requests: [] }; }
}

function saveDB(db) {
  writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
}

function loadFeedbackDB() {
  if (!existsSync(FEEDBACK_FILE)) return { feedbacks: [] };
  try { return JSON.parse(readFileSync(FEEDBACK_FILE, 'utf8')); }
  catch { return { feedbacks: [] }; }
}

function saveFeedbackDB(db) {
  writeFileSync(FEEDBACK_FILE, JSON.stringify(db, null, 2), 'utf8');
}

// ─────────────────────────────────────────────────────────────────────────────
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ─────────────────────────────────────────────────────────────────────────────

const STATUS_LABELS = {
  new:       'Новая',
  confirmed: 'Подтверждена',
  cancelled: 'Отменена',
  completed: 'Завершена',
  rejected:  'Отклонена',
};

function statusEmoji(status) {
  return { new: '🆕', confirmed: '✅', cancelled: '🚫', completed: '🏁', rejected: '❌' }[status] || '❓';
}

function isAdmin(userId) {
  if (ADMIN_IDS.length === 0) console.warn('⚠️  ADMIN_IDS не задан в .env');
  return ADMIN_IDS.includes(userId);
}

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function formatTripDate(dateStr) {
  if (!dateStr) return '—';
  const [y, m, d] = dateStr.split('-');
  return `${d}.${m}.${y}`;
}

const CATEGORY_LABELS = {
  disabled:   'Инвалид',
  pensioner:  'Пенсионер',
  svo:        'Участник СВО',
  svo_family: 'Член семьи участника СВО',
};

const DEST_CATEGORY_LABELS = {
  gov:            'Органы государственной власти',
  local_gov:      'Органы местного самоуправления',
  healthcare:     'Учреждения здравоохранения',
  social:         'Учреждения социального обслуживания',
  disability_org: 'Общества инвалидов',
  post:           'Почтовые отделения',
  bank:           'Банки России',
};

function servicesText(req) {
  const flags = [];
  if (req.boardingHelp) flags.push('🤝 Помощь при посадке');
  if (req.companion)    flags.push('👥 Сопровождение');
  if (req.waiting)      flags.push('⏳ Ожидание 30 мин.');
  return flags.length ? flags.join(', ') : 'Нет';
}

// ─────────────────────────────────────────────────────────────────────────────
// ПРОВЕРКА ЗАНЯТОСТИ 2 АВТОМОБИЛЕЙ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Проверяет, доступен ли хотя бы один автомобиль на заданную дату.
 * Считаем занятыми все активные (new/confirmed) заявки на ту же дату.
 * @returns {boolean} true — есть свободный автомобиль
 */
export function isCarAvailable(tripDate) {
  const db = loadDB();
  const activeStatuses = ['new', 'confirmed'];
  const count = db.requests.filter(r =>
    r.tripDate === tripDate && activeStatuses.includes(r.status)
  ).length;
  return count < 2;
}

// ─────────────────────────────────────────────────────────────────────────────
// CRUD
// ─────────────────────────────────────────────────────────────────────────────

export function addRequest(data) {
  const db = loadDB();
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const request = {
    id,
    ...data,
    status:          'new',
    statusLabel:     'Новая',
    operatorComment: '',
    cost:            null,
    car:             null,
    createdAt:       new Date().toISOString(),
    updatedAt:       new Date().toISOString(),
  };
  db.requests.push(request);
  saveDB(db);
  return request;
}

export function getRequestById(id) {
  const db = loadDB();
  return db.requests.find(r => r.id === id) || null;
}

export function getRequestsByUser(userId) {
  const db = loadDB();
  return db.requests
    .filter(r => r.senderUserId === String(userId))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

export function updateRequest(id, fields) {
  const db = loadDB();
  const req = db.requests.find(r => r.id === id);
  if (!req) return null;
  Object.assign(req, fields, { updatedAt: new Date().toISOString() });
  if (fields.status) req.statusLabel = STATUS_LABELS[fields.status] || fields.status;
  saveDB(db);
  return req;
}

export function cancelRequest(id, userId) {
  const db = loadDB();
  const req = db.requests.find(r => r.id === id);
  if (!req) return { ok: false, error: 'Заявка не найдена' };
  if (req.senderUserId !== String(userId) && !ADMIN_IDS.includes(userId)) {
    return { ok: false, error: 'Нет прав на отмену этой заявки' };
  }
  if (req.status === 'cancelled' || req.status === 'completed') {
    return { ok: false, error: 'Заявка уже отменена или завершена' };
  }

  // Проверяем — за 3 часа до поездки
  if (req.tripDate && req.tripTime) {
    const tripDt = new Date(`${req.tripDate}T${req.tripTime}:00`);
    const now    = new Date();
    const diffMs = tripDt - now;
    if (diffMs > 0 && diffMs < 3 * 60 * 60 * 1000) {
      return { ok: false, error: 'Отмена невозможна: до поездки менее 3 часов' };
    }
  }

  req.status      = 'cancelled';
  req.statusLabel = 'Отменена';
  req.updatedAt   = new Date().toISOString();
  saveDB(db);
  return { ok: true, req };
}

export function getActiveRequests() {
  const db = loadDB();
  return db.requests
    .filter(r => !['cancelled', 'completed', 'rejected'].includes(r.status))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 25);
}

export function getAllRequests() {
  return loadDB().requests.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

export function addFeedback(data) {
  const db = loadFeedbackDB();
  const id = Date.now().toString(36);
  const fb = { id, ...data, createdAt: new Date().toISOString() };
  db.feedbacks.push(fb);
  saveFeedbackDB(db);
  return fb;
}

export function getRecentFeedbacks(limit = 20) {
  return loadFeedbackDB().feedbacks
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, limit);
}

// ─────────────────────────────────────────────────────────────────────────────
// ФОРМАТИРОВАНИЕ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Карточка заявки для оператора (полная информация)
 */
function formatRequestForAdmin(req) {
  const cat  = CATEGORY_LABELS[req.category]         || req.category     || '—';
  const dcat = DEST_CATEGORY_LABELS[req.destCategory] || req.destCategory || '—';

  const lines = [
    `${statusEmoji(req.status)} *Заявка #${req.id.slice(-6).toUpperCase()}* — ${req.statusLabel}`,
    ``,
    `👤 *ФИО:* ${req.fullname || '—'}`,
    `🏠 *Адрес проживания:* ${req.address || '—'}`,
    `📞 *Телефон:* ${req.phone || '—'}`,
    `🎫 *Категория:* ${cat}`,
    req.certNumber ? `🪪 *Уд-ние:* ${req.certNumber}` : null,
    ``,
    `🗓 *Дата поездки:* ${formatTripDate(req.tripDate)}${req.tripTime ? ' в ' + req.tripTime : ''}`,
    `🏛 *Тип объекта:* ${dcat}`,
    `📍 *Учреждение:* ${req.destInstitution || '—'}`,
    `🗺 *Адрес назначения:* ${req.destAddress || '—'}`,
    req.needReturn
      ? `🔄 *Обратная поездка:* ${formatTripDate(req.returnDate)}${req.returnTime ? ' в ' + req.returnTime : ''}`
      : null,
    ``,
    `🔧 *Доп. услуги:* ${servicesText(req)}`,
    req.comment         ? `💬 *Комментарий:* ${req.comment}` : null,
    req.cost            ? `💰 *Стоимость:* ${req.cost} руб.` : null,
    req.car             ? `🚗 *Автомобиль:* ${req.car}` : null,
    req.operatorComment ? `📝 *Коммент. оператора:* ${req.operatorComment}` : null,
    ``,
    `🕐 *Подана:* ${formatDate(req.createdAt)}`,
  ];
  return lines.filter(l => l !== null).join('\n');
}

/**
 * Подтверждение для пользователя после отправки заявки
 */
function formatRequestForUser(req) {
  const lines = [
    `✅ *Заявка принята!*`,
    ``,
    `Номер: *#${req.id.slice(-6).toUpperCase()}*`,
    `Дата поездки: *${formatTripDate(req.tripDate)}${req.tripTime ? ' в ' + req.tripTime : ''}*`,
    `Учреждение: *${req.destInstitution || '—'}*`,
    `Адрес: ${req.destAddress || '—'}`,
    req.needReturn
      ? `🔄 Обратная поездка: *${formatTripDate(req.returnDate)}${req.returnTime ? ' в ' + req.returnTime : ''}*`
      : null,
    ``,
    // После подтверждения оператором пользователю придёт отдельное сообщение
    // с данными автомобиля, временем подачи и стоимостью поездки
    `⏳ Ожидайте подтверждения от оператора — вам придёт сообщение в этом чате.`,
    ``,
    `Оплата наличными водителю. При посадке — паспорт.`,
  ];
  return lines.filter(l => l !== null).join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// КЛАВИАТУРЫ
// ─────────────────────────────────────────────────────────────────────────────

function isLocalMiniAppUrl(url) {
  return /(^|\/\/)(localhost|127\.0\.0\.1)(:|\/|$)/.test(url);
}

function miniAppButton(text, url) {
  return {
    type: 'open_app',
    text,
    url,
  };
}

function mainKeyboard() {
  const orderButton = isLocalMiniAppUrl(MINI_APP_URL)
    ? Keyboard.button.callback('🚖 Заказать такси', 'order_local_unavailable')
    : miniAppButton('🚖 Заказать такси', MINI_APP_URL);

  return Keyboard.inlineKeyboard([
    [orderButton],
    [
      Keyboard.button.callback('📋 Правила', 'show_rules'),
      Keyboard.button.callback('💰 Стоимость', 'show_prices'),
    ],
    [
      Keyboard.button.callback('⏰ График работы', 'show_schedule'),
      Keyboard.button.callback('📞 Связаться с оператором', 'contact_operator'),
    ],
    [Keyboard.button.callback('⭐ Оставить отзыв', 'show_feedback_info')],
  ]);
}

function adminMainKeyboard() {
  return Keyboard.inlineKeyboard([
    [
      Keyboard.button.callback('📋 Активные заявки', 'admin_list_active'),
      Keyboard.button.callback('📁 Все заявки', 'admin_list_all'),
    ],
    [
      Keyboard.button.callback('📊 Статистика', 'admin_stats'),
      Keyboard.button.callback('⭐ Отзывы', 'admin_feedbacks'),
    ],
  ]);
}

function adminRequestKeyboard(reqId) {
  return Keyboard.inlineKeyboard([
    [
      Keyboard.button.callback('✅ Подтвердить', `confirm:${reqId}`),
      Keyboard.button.callback('🏁 Завершить',   `complete:${reqId}`),
    ],
    [
      Keyboard.button.callback('🚫 Отменить',  `admin_cancel:${reqId}`),
      Keyboard.button.callback('❌ Отклонить', `reject:${reqId}`),
    ],
    [
      Keyboard.button.callback('💰 Указать стоимость', `set_cost:${reqId}`),
      Keyboard.button.callback('🚗 Указать автомобиль', `set_car:${reqId}`),
    ],
    [Keyboard.button.callback('💬 Написать комментарий', `set_comment:${reqId}`)],
    [Keyboard.button.callback('← Список заявок', 'admin_list_active')],
  ]);
}

function backKeyboard() {
  return Keyboard.inlineKeyboard([
    [Keyboard.button.callback('← Главное меню', 'go_home')],
  ]);
}

function adminBackKeyboard() {
  return Keyboard.inlineKeyboard([
    [Keyboard.button.callback('← Меню оператора', 'admin_menu')],
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// ТЕКСТЫ
// ─────────────────────────────────────────────────────────────────────────────

const WELCOME_USER = `🚖 *Социальное такси — г. Курган*

Добро пожаловать! Бот предназначен для оформления заявок на социальное такси для маломобильных граждан.

Если у вас остались вопросы — позвоните оператору: *8 (3522) 45-97-88*

Выберите раздел:`;

const WELCOME_ADMIN = `🔐 *Панель оператора*

Вы вошли как оператор социального такси.`;

const RULES_TEXT = `📋 *Правила предоставления услуги*

*Категории граждан:*
• Инвалиды (с документальным подтверждением)
• Пенсионеры
• Участники СВО
• Члены семей участников СВО

*Условия:*
• Заявка подаётся *не менее чем за 3 суток* до поездки
• Заявка считается принятой *только после подтверждения оператором*
• При посадке обязательно *наличие паспорта*
• Оплата *наличными водителю*
• Отмена — *не позднее чем за 3 часа* до поездки
• Поездки выполняются *только по г. Кургану*

Доступно *2 автомобиля*.`;

const PRICES_TEXT = `💰 *Стоимость услуги*

*По городу Кургану:*
119 – 342 руб. (в зависимости от района)

*За пределами г. Кургана:*
+22 руб. за 1 км после выезда за черту города

*Ожидание 30 минут:*
• Летом: 148 руб.
• Зимой: 188 руб.

Точная стоимость определяется оператором при подтверждении заявки.
Оплата наличными водителю.`;

const SCHEDULE_TEXT = `⏰ *График работы*

Понедельник – Четверг: *08:00 – 17:00*
Пятница: *08:00 – 16:00*
Суббота, Воскресенье: *Выходной*

Заявки принимаются через бот круглосуточно, но обрабатываются только в рабочее время.`;

const CONTACT_TEXT = `📞 *Связь с оператором*

Если у вас остались вопросы или возникли затруднения — начните новый диалог в боте или позвоните оператору для вызова социального такси:

📱 *8 (3522) 45-97-88*

Вы также можете оставить отзыв о поездке через мини-приложение.`;

const FEEDBACK_INFO_TEXT = `⭐ *Оставить отзыв*

Вы можете оценить работу службы в мини-приложении:`;

const FAQ = [
  {
    pattern: /помо(щь|гите|жите)|не знаю|не понимаю|что делать/i,
    // Убрана фраза "оператор перезвонит" — подтверждение приходит сообщением в бот
    reply: `ℹ️ *Как пользоваться:*\n\n1. Нажмите *«Заказать такси»*\n2. Заполните форму (ФИО, телефон, адрес, учреждение, дата)\n3. Ожидайте подтверждения — оператор пришлёт сообщение в этот чат`,
  },
  {
    pattern: /бесплатн|стоим|цена|платить|деньги/i,
    reply: `💰 Стоимость по г. Кургану: *119–342 руб.* (зависит от района).\nЗа пределами города: +22 руб./км.\nОжидание 30 мин.: летом 148 руб., зимой 188 руб.\nОплата наличными водителю.`,
  },
  {
    pattern: /отмен/i,
    reply: `🚫 Заявку можно отменить через мини-приложение — вкладка «Мои заявки».\nОтмена возможна *не позднее чем за 3 часа* до поездки.`,
  },
  {
    pattern: /время|когда|срок|сутки|график/i,
    reply: `⏰ Заявка подаётся за *3 суток*.\nГрафик: Пн–Чт 08–17, Пт 08–16.\nСуббота и воскресенье — нерабочие дни.`,
  },
  {
    pattern: /доку(мент|менты)|снилс|паспорт/i,
    reply: `📄 При посадке необходим *паспорт* и документ, подтверждающий льготу.`,
  },
  {
    pattern: /статус|заявк/i,
    reply: `🔍 Статус заявки обновляется оператором. Вы получите уведомление в этом чате.`,
  },
  {
    pattern: /автомоб|машин|транспорт/i,
    reply: `🚗 Доступно *2 автомобиля*. Если оба заняты на выбранную дату — оформление будет недоступно.`,
  },
  {
    pattern: /куда|маршрут|адрес|учреждени/i,
    reply: `📍 Социальное такси следует до социально значимых объектов Кургана: поликлиники, больницы, МФЦ, органы власти, почта, банки и другие. Адрес назначения выбирается в форме заявки.`,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// ПРИЁМ ЗАЯВКИ (вызывается из server.js)
// ─────────────────────────────────────────────────────────────────────────────
// handleNewRequest и handleFeedback — единственные точки входа из server.js.
// server.js импортирует их и вызывает при POST-запросах из мини-приложения.

export async function handleNewRequest(requestData, senderUserId) {
  // Проверка занятости автомобилей
  if (requestData.tripDate) {
    const available = isCarAvailable(requestData.tripDate);
    if (!available) {
      throw new Error('На выбранную дату оба автомобиля заняты. Выберите другую дату.');
    }
  }

  const req = addRequest({
    ...requestData,
    senderUserId: senderUserId ? String(senderUserId) : null,
  });

  // Уведомляем заявителя
  if (senderUserId) {
    try {
      await bot.api.sendMessageToUser(senderUserId, formatRequestForUser(req), {
        format: 'markdown',
        attachments: [backKeyboard()],
      });
    } catch(e) {
      console.error('Не удалось уведомить заявителя:', e.message);
    }
  }

  // Уведомляем операторов
  for (const adminId of ADMIN_IDS) {
    try {
      await bot.api.sendMessageToUser(
        adminId,
        `🔔 *Новая заявка на такси!*\n\n` + formatRequestForAdmin(req),
        { format: 'markdown', attachments: [adminRequestKeyboard(req.id)] }
      );
    } catch(e) {
      console.error(`Не удалось уведомить оператора ${adminId}:`, e.message);
    }
  }

  console.log(`📥 Новая заявка #${req.id.slice(-6).toUpperCase()} от ${req.fullname}`);
  return req;
}

export async function handleFeedback(data) {
  const fb = addFeedback(data);

  // Уведомляем операторов
  const stars = '★'.repeat(data.rating) + '☆'.repeat(5 - data.rating);
  for (const adminId of ADMIN_IDS) {
    try {
      await bot.api.sendMessageToUser(
        adminId,
        `⭐ *Новый отзыв!*\n\n` +
        `Оценка: ${stars} (${data.rating}/5)\n` +
        (data.requestId ? `Заявка: #${data.requestId}\n` : '') +
        (data.car       ? `Автомобиль: ${data.car}\n` : '') +
        (data.cost      ? `Стоимость: ${data.cost} руб.\n` : '') +
        `\nТекст: ${data.text}`,
        { format: 'markdown', attachments: [adminBackKeyboard()] }
      );
    } catch(e) {
      console.error(`Не удалось уведомить оператора ${adminId}:`, e.message);
    }
  }

  return fb;
}

export async function processWebhookUpdate(update) {
  if (!update || typeof update !== 'object' || !update.update_type) {
    throw new Error('Некорректное событие MAX: отсутствует update_type');
  }

  // В режиме webhook bot.start() не вызывается, поэтому сведения о боте
  // загружаем один раз перед обработкой первого события.
  if (!bot.botInfo) {
    bot.botInfo = await bot.api.getMyInfo();
  }

  // В текущей версии @maxhub/max-bot-api обработчик Update не опубликован
  // в типах, но используется библиотекой для long polling и доступен в runtime.
  await bot.handleUpdate(update);
}

async function notifyUser(userId, text) {
  if (!userId) return;
  try {
    await bot.api.sendMessageToUser(userId, text, {
      format: 'markdown',
      attachments: [backKeyboard()],
    });
  } catch(e) {
    console.error(`Не удалось уведомить пользователя ${userId}:`, e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// СОСТОЯНИЕ ДЛЯ МНОГОШАГОВЫХ ДЕЙСТВИЙ ОПЕРАТОРА
// ─────────────────────────────────────────────────────────────────────────────

// Временное хранилище многошаговых действий оператора.
// Когда оператор нажимает «Указать стоимость» / «Указать авто» / «Комментарий»,
// сюда записывается { action, reqId }. Следующее текстовое сообщение от этого
// оператора трактуется как ввод нужного значения.
// Формат: userId → { action: 'set_cost'|'set_car'|'set_comment', reqId }
const pendingActions = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// ОБРАБОТЧИКИ
// ─────────────────────────────────────────────────────────────────────────────

async function sendStart(ctx) {
  const userId = ctx.user?.user_id;
  if (userId && isAdmin(userId)) {
    await ctx.reply(WELCOME_ADMIN, { format: 'markdown', attachments: [adminMainKeyboard()] });
  } else {
    await ctx.reply(WELCOME_USER, { format: 'markdown', attachments: [mainKeyboard()] });
  }
}

bot.command('start', sendStart);
bot.on('bot_started', sendStart);

bot.command('admin', async (ctx) => {
  if (!isAdmin(ctx.user?.user_id)) { await ctx.reply('Нет доступа.'); return; }
  await ctx.reply(WELCOME_ADMIN, { format: 'markdown', attachments: [adminMainKeyboard()] });
});

// ── Пользовательские кнопки меню ──

bot.action('go_home', async (ctx) => {
  const userId = ctx.user?.user_id;
  if (userId && isAdmin(userId)) {
    await ctx.reply(WELCOME_ADMIN, { format: 'markdown', attachments: [adminMainKeyboard()] });
  } else {
    await ctx.reply(WELCOME_USER, { format: 'markdown', attachments: [mainKeyboard()] });
  }
});

bot.action('order_local_unavailable', async (ctx) => {
  await ctx.reply(
    `Форма заказа пока запущена локально на компьютере и не открывается с телефона.\n\n` +
    `Для проверки в MAX нужен публичный HTTPS-адрес мини-приложения. Локально форму можно открыть в браузере компьютера:\n${MINI_APP_URL}`,
    { attachments: [backKeyboard()] }
  );
});

bot.action('show_rules', async (ctx) => {
  await ctx.reply(RULES_TEXT, { format: 'markdown', attachments: [backKeyboard()] });
});

bot.action('show_prices', async (ctx) => {
  await ctx.reply(PRICES_TEXT, { format: 'markdown', attachments: [backKeyboard()] });
});

bot.action('show_schedule', async (ctx) => {
  await ctx.reply(SCHEDULE_TEXT, { format: 'markdown', attachments: [backKeyboard()] });
});

bot.action('contact_operator', async (ctx) => {
  await ctx.reply(CONTACT_TEXT, { format: 'markdown', attachments: [backKeyboard()] });
});

bot.action('show_feedback_info', async (ctx) => {
  await ctx.reply(FEEDBACK_INFO_TEXT, {
    format: 'markdown',
    attachments: [
      Keyboard.inlineKeyboard([
        [
          isLocalMiniAppUrl(MINI_APP_URL)
            ? Keyboard.button.callback('⭐ Открыть форму отзыва', 'order_local_unavailable')
            : miniAppButton('⭐ Открыть форму отзыва', MINI_APP_URL),
        ],
        [Keyboard.button.callback('← Главное меню', 'go_home')],
      ])
    ]
  });
});

// ── Админ-меню ──

bot.action('admin_menu', async (ctx) => {
  if (!isAdmin(ctx.user?.user_id)) return;
  await ctx.reply(WELCOME_ADMIN, { format: 'markdown', attachments: [adminMainKeyboard()] });
});

bot.action('admin_list_active', async (ctx) => {
  if (!isAdmin(ctx.user?.user_id)) return;
  const requests = getActiveRequests();
  if (!requests.length) {
    await ctx.reply('📭 Активных заявок нет.', { attachments: [adminBackKeyboard()] });
    return;
  }
  await ctx.reply(`📋 *Активные заявки (${requests.length}):*`, { format: 'markdown' });
  for (const req of requests) {
    await bot.api.sendMessageToUser(
      ctx.user.user_id,
      formatRequestForAdmin(req),
      { format: 'markdown', attachments: [adminRequestKeyboard(req.id)] }
    );
  }
});

bot.action('admin_list_all', async (ctx) => {
  if (!isAdmin(ctx.user?.user_id)) return;
  const requests = getAllRequests().slice(0, 30);
  if (!requests.length) {
    await ctx.reply('📭 Заявок пока нет.', { attachments: [adminBackKeyboard()] });
    return;
  }
  const lines = requests.map((r, i) => {
    return `${i + 1}. ${statusEmoji(r.status)} #${r.id.slice(-6).toUpperCase()} — ${r.fullname || '—'} — ${formatTripDate(r.tripDate)} — ${r.statusLabel}`;
  });
  await ctx.reply(
    `📁 *Все заявки (${requests.length}):*\n\n` + lines.join('\n'),
    { format: 'markdown', attachments: [adminBackKeyboard()] }
  );
});

bot.action('admin_stats', async (ctx) => {
  if (!isAdmin(ctx.user?.user_id)) return;
  const all = getAllRequests();
  const counts = {};
  for (const r of all) counts[r.status] = (counts[r.status] || 0) + 1;
  const today = new Date().toISOString().slice(0, 10);
  const todayCount = all.filter(r => r.createdAt.startsWith(today)).length;
  const fbs = loadFeedbackDB().feedbacks;
  const avgRating = fbs.length
    ? (fbs.reduce((s, f) => s + (f.rating || 0), 0) / fbs.length).toFixed(1)
    : '—';

  await ctx.reply(
    `📊 *Статистика заявок*\n\n` +
    `🆕 Новых: ${counts.new || 0}\n` +
    `✅ Подтверждённых: ${counts.confirmed || 0}\n` +
    `🏁 Завершённых: ${counts.completed || 0}\n` +
    `🚫 Отменённых: ${counts.cancelled || 0}\n` +
    `❌ Отклонённых: ${counts.rejected || 0}\n` +
    `──────────────\n` +
    `📦 Всего: ${all.length}\n` +
    `📅 Сегодня подано: ${todayCount}\n` +
    `⭐ Средний рейтинг: ${avgRating} (${fbs.length} отзывов)`,
    { format: 'markdown', attachments: [adminBackKeyboard()] }
  );
});

bot.action('admin_feedbacks', async (ctx) => {
  if (!isAdmin(ctx.user?.user_id)) return;
  const fbs = getRecentFeedbacks(15);
  if (!fbs.length) {
    await ctx.reply('📭 Отзывов пока нет.', { attachments: [adminBackKeyboard()] });
    return;
  }
  const lines = fbs.map(f => {
    const stars = '★'.repeat(f.rating) + '☆'.repeat(5 - f.rating);
    const reqPart = f.requestId ? ` (#${f.requestId})` : '';
    const carPart  = f.car  ? `\n🚗 ${f.car}`           : '';
    const costPart = f.cost ? `\n💰 ${f.cost} руб.`      : '';
    return `${stars}${reqPart}${carPart}${costPart}\n${f.text}\n${formatDate(f.createdAt)}`;
  });
  await ctx.reply(
    `⭐ *Последние отзывы (${fbs.length}):*\n\n` + lines.join('\n\n──────────\n\n'),
    { format: 'markdown', attachments: [adminBackKeyboard()] }
  );
});

// ── Смена статусов ──

bot.action(/^confirm:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx.user?.user_id)) return;
  const reqId = ctx.payload.split(':')[1];
  const req = updateRequest(reqId, { status: 'confirmed' });
  if (!req) { await ctx.reply('Заявка не найдена.'); return; }
  await ctx.reply(
    `✅ Заявка *#${req.id.slice(-6).toUpperCase()}* подтверждена. Клиент уведомлён.`,
    { format: 'markdown', attachments: [adminRequestKeyboard(req.id)] }
  );
  // Если оператор уже назначил автомобиль — показываем его номер в уведомлении
  const carInfo = req.car ? `\n🚗 Автомобиль: *${req.car}*` : '';
  const costInfo = req.cost ? `\n💰 Стоимость: *${req.cost} руб.*` : '';
  await notifyUser(
    req.senderUserId,
    `✅ *Ваша заявка подтверждена!*\n\n` +
    `Поездка: *${formatTripDate(req.tripDate)}${req.tripTime ? ' в ' + req.tripTime : ''}*\n` +
    `Учреждение: *${req.destInstitution || '—'}*\n` +
    `Адрес назначения: ${req.destAddress || '—'}` +
    carInfo + costInfo + `\n\n` +
    `Не забудьте паспорт при посадке. Оплата наличными водителю.`
  );
});

bot.action(/^complete:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx.user?.user_id)) return;
  const reqId = ctx.payload.split(':')[1];
  const req = updateRequest(reqId, { status: 'completed' });
  if (!req) { await ctx.reply('Заявка не найдена.'); return; }
  await ctx.reply(
    `🏁 Заявка *#${req.id.slice(-6).toUpperCase()}* завершена.`,
    { format: 'markdown', attachments: [adminBackKeyboard()] }
  );
  await notifyUser(
    req.senderUserId,
    `🏁 *Поездка завершена*\n\n` +
    `Заявка *#${req.id.slice(-6).toUpperCase()}* отмечена как завершённая.\n\n` +
    `Спасибо, что воспользовались социальным такси!\n` +
    `Оставьте отзыв через мини-приложение — вкладка «Отзыв» ⭐`
  );
});

bot.action(/^admin_cancel:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx.user?.user_id)) return;
  const reqId = ctx.payload.split(':')[1];
  const result = cancelRequest(reqId, ctx.user.user_id);
  if (!result.ok) { await ctx.reply(`⚠️ ${result.error}`); return; }
  const req = result.req;
  await ctx.reply(
    `🚫 Заявка *#${req.id.slice(-6).toUpperCase()}* отменена. Клиент уведомлён.`,
    { format: 'markdown', attachments: [adminBackKeyboard()] }
  );
  await notifyUser(
    req.senderUserId,
    `🚫 *Заявка #${req.id.slice(-6).toUpperCase()} отменена*\n\n` +
    `Оператор отменил вашу заявку на *${formatTripDate(req.tripDate)}*.\n` +
    `Пожалуйста, свяжитесь со службой по телефону для уточнения.`
  );
});

bot.action(/^reject:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx.user?.user_id)) return;
  const reqId = ctx.payload.split(':')[1];
  const req = updateRequest(reqId, { status: 'rejected' });
  if (!req) { await ctx.reply('Заявка не найдена.'); return; }
  await ctx.reply(
    `❌ Заявка *#${req.id.slice(-6).toUpperCase()}* отклонена. Клиент уведомлён.`,
    { format: 'markdown', attachments: [adminBackKeyboard()] }
  );
  await notifyUser(
    req.senderUserId,
    `❌ *Заявка #${req.id.slice(-6).toUpperCase()} отклонена*\n\n` +
    `К сожалению, заявка на поездку *${formatTripDate(req.tripDate)}* не может быть выполнена.\n` +
    `Обратитесь к оператору по телефону для уточнения.`
  );
});

// ── Многошаговые действия оператора ──

bot.action(/^set_cost:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx.user?.user_id)) return;
  const reqId = ctx.payload.split(':')[1];
  const req = getRequestById(reqId);
  if (!req) { await ctx.reply('Заявка не найдена.'); return; }
  pendingActions.set(ctx.user.user_id, { action: 'set_cost', reqId });
  await ctx.reply(
    `💰 Введите стоимость поездки для заявки *#${req.id.slice(-6).toUpperCase()}* (только цифры, в рублях):`,
    { format: 'markdown' }
  );
});

bot.action(/^set_car:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx.user?.user_id)) return;
  const reqId = ctx.payload.split(':')[1];
  const req = getRequestById(reqId);
  if (!req) { await ctx.reply('Заявка не найдена.'); return; }
  pendingActions.set(ctx.user.user_id, { action: 'set_car', reqId });
  await ctx.reply(
    `🚗 Введите марку и номер автомобиля для заявки *#${req.id.slice(-6).toUpperCase()}*\n(например: Лада Гранта А123БВ45):`,
    { format: 'markdown' }
  );
});

bot.action(/^set_comment:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx.user?.user_id)) return;
  const reqId = ctx.payload.split(':')[1];
  const req = getRequestById(reqId);
  if (!req) { await ctx.reply('Заявка не найдена.'); return; }
  pendingActions.set(ctx.user.user_id, { action: 'set_comment', reqId });
  await ctx.reply(
    `💬 Введите комментарий для клиента по заявке *#${req.id.slice(-6).toUpperCase()}*:`,
    { format: 'markdown' }
  );
});

// ── Входящие сообщения ──

bot.on('message_created', async (ctx) => {
  const userId = ctx.user?.user_id;
  const text   = (ctx.message?.body?.text ?? '').trim();

  // Обработка многошаговых действий администратора
  if (isAdmin(userId) && pendingActions.has(userId)) {
    const pending = pendingActions.get(userId);
    pendingActions.delete(userId);

    if (pending.action === 'set_cost') {
      const cost = parseInt(text);
      if (isNaN(cost) || cost < 0) {
        await ctx.reply('⚠️ Некорректная сумма. Введите целое число (рублей).', { attachments: [adminBackKeyboard()] });
        return;
      }
      const req = updateRequest(pending.reqId, { cost });
      if (!req) { await ctx.reply('Заявка не найдена.'); return; }
      await ctx.reply(
        `💰 Стоимость *${cost} руб.* сохранена для заявки *#${req.id.slice(-6).toUpperCase()}*.`,
        { format: 'markdown', attachments: [adminRequestKeyboard(req.id)] }
      );
      await notifyUser(
        req.senderUserId,
        `💰 *Стоимость вашей поездки:* ${cost} руб.\n\nОплата наличными водителю.\nЗаявка: *#${req.id.slice(-6).toUpperCase()}*`
      );
      return;
    }

    if (pending.action === 'set_car') {
      const car = text.trim();
      if (!car || car.length < 3) {
        await ctx.reply('⚠️ Некорректные данные. Введите марку и номер автомобиля.', { attachments: [adminBackKeyboard()] });
        return;
      }
      const req = updateRequest(pending.reqId, { car });
      if (!req) { await ctx.reply('Заявка не найдена.'); return; }
      await ctx.reply(
        `🚗 Автомобиль *${car}* назначен для заявки *#${req.id.slice(-6).toUpperCase()}*.`,
        { format: 'markdown', attachments: [adminRequestKeyboard(req.id)] }
      );
      await notifyUser(
        req.senderUserId,
        `🚗 *Автомобиль назначен!*\n\nВаша заявка *#${req.id.slice(-6).toUpperCase()}*:\nАвтомобиль: *${car}*`
      );
      return;
    }

    if (pending.action === 'set_comment') {
      const comment = text.trim();
      if (!comment) {
        await ctx.reply('⚠️ Комментарий не может быть пустым.', { attachments: [adminBackKeyboard()] });
        return;
      }
      const req = updateRequest(pending.reqId, { operatorComment: comment });
      if (!req) { await ctx.reply('Заявка не найдена.'); return; }
      await ctx.reply(
        `💬 Комментарий сохранён для заявки *#${req.id.slice(-6).toUpperCase()}*.`,
        { format: 'markdown', attachments: [adminRequestKeyboard(req.id)] }
      );
      await notifyUser(
        req.senderUserId,
        `💬 *Сообщение от оператора* по заявке *#${req.id.slice(-6).toUpperCase()}*:\n\n${comment}`
      );
      return;
    }
  }

  // Сообщение от оператора вне контекста → показываем меню
  if (isAdmin(userId)) {
    await ctx.reply(WELCOME_ADMIN, { format: 'markdown', attachments: [adminMainKeyboard()] });
    return;
  }

  // FAQ для пользователей
  for (const item of FAQ) {
    if (item.pattern.test(text)) {
      await ctx.reply(item.reply, { format: 'markdown', attachments: [backKeyboard()] });
      return;
    }
  }

  // Дефолтный ответ
  await ctx.reply(
    `Я не совсем понял ваш запрос 🤔\n\nВоспользуйтесь кнопками меню ниже.`,
    { format: 'markdown', attachments: [mainKeyboard()] }
  );
});

// ─────────────────────────────────────────────────────────────────────────────
const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMainModule) {
  bot.start();
  console.log('✅ Бот социального такси запущен');
  if (ADMIN_IDS.length > 0) {
    console.log(`👮 Операторы: ${ADMIN_IDS.join(', ')}`);
  } else {
    console.warn('⚠️  ADMIN_IDS не задан в .env!');
  }
}
