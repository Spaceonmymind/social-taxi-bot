# Деплой MAX-бота и мини-приложения

Самый простой вариант для этого проекта: разместить весь проект на одном Node.js-хостинге.
Тогда публичный HTTPS-адрес будет один:

```text
https://your-app.up.railway.app/miniapp/index.html
```

Этот адрес нужно прописать в `MINI_APP_URL` и в настройках мини-приложения MAX.

## Почему лучше один хостинг

`miniapp/index.html` отправляет заявки на относительные адреса:

```js
/api/submit-request
/api/my-requests
/api/cancel-request
/api/submit-feedback
```

Если форма и сервер лежат на одном домене, всё работает сразу. Если форму положить отдельно на GitHub Pages или Vercel, нужно дополнительно менять JS в форме, чтобы она отправляла заявки на URL backend-сервера.

## Вариант A: Railway

1. Создайте GitHub-репозиторий и загрузите туда проект.

2. Проверьте, что в репозиторий не попали секреты:

```text
.env
node_modules/
requests.json
feedback.json
```

Они уже добавлены в `.gitignore`.

3. На Railway создайте новый проект из GitHub-репозитория.

4. В настройках сервиса добавьте переменные окружения:

```env
BOT_TOKEN=токен_бота_MAX
ADMIN_IDS=19154272
ADMIN_TOKEN=случайная_строка_минимум_16_символов
WEBHOOK_SECRET=случайная_строка_для_MAX_webhook
MINI_APP_URL=https://адрес-railway/miniapp/index.html
PORT=3000
DB_FILE=./requests.json
FEEDBACK_FILE=./feedback.json
```

5. Production start command:

```bash
npm start
```

Она запускает HTTP-сервер с `/webhook` и не включает Long Polling.
Для локальной разработки через Long Polling используйте:

```bash
npm run start:polling
```

6. После деплоя Railway выдаст публичный HTTPS-домен. Откройте:

```text
https://адрес-railway/health
```

Если ответ `{"status":"ok"}`, сервер жив.

7. Откройте форму:

```text
https://адрес-railway/miniapp/index.html
```

8. Вернитесь в переменные окружения Railway и замените `MINI_APP_URL` на настоящий адрес формы.
После изменения переменных сделайте redeploy/restart сервиса.

9. В MAX Business/Developer настройках бота укажите тот же URL мини-приложения:

```text
https://адрес-railway/miniapp/index.html
```

## Вариант B: VPS

1. Купите VPS с Ubuntu.
2. Установите Node.js 18+ и git.
3. Скопируйте проект на сервер.
4. В корне проекта создайте `.env`.
5. Выполните:

```bash
npm install
npm start
```

6. Для постоянной работы используйте `pm2`.
7. Для HTTPS поставьте Nginx как reverse proxy и сертификат Let's Encrypt.

## Важное для продакшена

- Токен бота нельзя хранить в публичном репозитории.
- Перед настоящим запуском лучше перевыпустить токен, если он уже где-то светился.
- JSON-файлы подходят для тестов. Для реальной эксплуатации лучше подключить PostgreSQL, MongoDB или хотя бы постоянный volume на хостинге.
- Для MAX мини-приложения нужен публичный `https://`, локальный `localhost` с телефона не работает.
