# File Viewer

Одностраничный просмотрщик Markdown (`.md`) и JSON (`.json`) файлов по URL или из локального файла. Поддерживает подсветку синтаксиса, переключение светлой/тёмной темы, компактный режим, а также рендеринг диаграмм Mermaid, PlantUML, Pikchr и внешних SVG (draw.io).

Открывается по адресу вида:

```
https://<viewer-domain>/?url=https://<any-host>/path/file.md
```

## Возможности

- Markdown (через `marked`) с таблицами GFM, якорями заголовков и кнопкой «копировать» у блоков кода.
- JSON-viewer с фильтром, сворачиванием узлов и подсчётом ключей.
- Диаграммы из fenced code blocks:
  - **Mermaid** — ` ```mermaid ` / ` ```mmd `
  - **PlantUML** — ` ```plantuml ` / ` ```puml `
  - **Pikchr** — ` ```pikchr `
- Изображения (включая **draw.io SVG**) — через обычный `![](...)`, с автоматическим резолвингом относительных URL относительно источника Markdown.
- Декодирование URL GitHub/GitLab `blob/` → `raw/` для прямой загрузки.
- Подсветка синтаксиса кода через highlight.js с переключением тем.
- Light/Dark тема с сохранением через `prefers-color-scheme`, плюс ручной переключатель.
- Компактный режим для широкого контента (таблиц, длинных листингов).

## Внешние библиотеки

Все библиотеки **самохостятся** в каталоге `vendor/` — приложение не зависит от внешних CDN и продолжает работать, даже если CDN заблокирован.

| Файл                | Назначение                       | Версия | Источник                                                       |
| ------------------- | -------------------------------- | ------ | -------------------------------------------------------------- |
| `marked.min.js`     | Парсинг Markdown                 | 12     | https://cdn.jsdelivr.net/npm/marked@12/marked.min.js             |
| `highlight.min.js`  | Подсветка кода                   | 11.9.0 | https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/    |
| `hljs-dark.css`     | Тема highlight.js (тёмная)       | 11.9.0 | …/styles/github-dark.min.css                                  |
| `hljs-light.css`    | Тема highlight.js (светлая)      | 11.9.0 | …/styles/github.min.css                                       |
| `mermaid.min.js`    | Рендеринг Mermaid-диаграмм       | 11     | https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js      |
| `pikchr.js`         | Рендеринг Pikchr-диаграмм (WASM) | 0.1.4  | https://cdn.jsdelivr.net/npm/pikchr-js/pikchr.js                 |

Обновление любой библиотеки:

```bash
curl -sL "<URL из таблицы выше>" -o vendor/<file>
# задеплоить vendor/ на сервер (см. ниже)
```

Шрифты Satoshi и JetBrains Mono подключаются через `<link>` с fontshare.com и fonts.googleapis.com. Если эти домены недоступны, браузер автоматически откатывается на системные шрифты — функциональность не страдает.

## Загрузка внешних файлов: `/api/fetch`

### Зачем нужен

Браузер по умолчанию блокирует `fetch()` к доменам, которые не отдают `Access-Control-Allow-Origin`. Чтобы просмотрщик работал с **любыми** http(s)-источниками (объектные storages, внутренние HTTP-серверы, GitHub/GitLab raw, произвольные сайты без настроенного CORS), на бэкенде работает SSRF-safe прокси-эндпоинт `GET /api/fetch?url=<encoded>`.

Фронтенд всегда идёт через `/api/fetch` (single source of truth) — больше никаких внешних публичных проксей (`cors.eu.org`, `allorigins.win`), никакой захардкоженной привязки к конкретному storage-домену.

### Архитектура

- **Frontend** (`index.html`): все запросы к внешним URL идут через единственный proxy `'/api/fetch?url=' + encodeURIComponent(url)` в массиве `PROXIES`. Изображения в Markdown (`![](...)`) грузятся браузером напрямую — для них нужен `img-src` в CSP.
- **Backend** (`backend/server.js`, тот же процесс, что и DOCX-экспорт): endpoint `GET /api/fetch` резолвит upstream, проверяет IP, делает запрос и отдаёт тело с `Access-Control-Allow-Origin: *`.
- **Nginx**: `location /api/` проксирует на `127.0.0.1:3001` (см. `md.mtsa-next.ru.conf`).

### Модель безопасности (SSRF-защита)

Прокси не является open-relay — он отвергает запросы к внутренним/приватным адресам, чтобы предотвратить SSRF-атаки на хостинг-инфраструктуру:

| Проверка                          | Реализация                                                                                                       |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Протокол**                      | Только `http:` / `https:`. `file:`, `ftp:`, `data:` и пр. → 400.                                                  |
| **Приватные/зарезервированные IP** | `net.BlockList` покрывает RFC1918 (10/8, 172.16/12, 192.168/16), loopback 127/8, link-local 169.254/16 (**включая cloud-metadata 169.254.169.254**), CGNAT 100.64/10, TEST-NET, multicast, reserved, IPv6 `::1`, `fc00::/7`, `fe80::/10`. |
| **DNS-резолв**                    | Все A/AAAA записи проверяются до соединения. Если хоть одна запись приватная → 400.                               |
| **IP literal в URL**              | Проверяется напрямую через `net.isIP` (Node обходит `lookup` для numeric hostname).                              |
| **Redirects**                     | До 3 редиректов, каждый пере-валидируется (URL + DNS + IP).                                                       |
| **Размер ответа**                 | До 10 MB (`FETCH_MAX_BYTES`), сверх — 413.                                                                       |
| **Таймаут**                       | 10 с на upstream-запрос (`FETCH_TIMEOUT_MS`).                                                                    |
| **Rate limit**                    | 30 запросов/мин на клиентский IP (`X-Real-IP` или socket), in-memory bucket.                                      |

Код集中在 функциях `resolveAndCheck`, `validateFetchUrl`, `fetchUpstream` в `backend/server.js`.

### Что важно для LLM-агента

- **Прокси обязателен.** Без backend-сервиса просмотрщик не сможет загружать никакие внешние файлы (только локальные через «Открыть»).
- **Backend один на оба endpoint'а**: `/api/fetch` (GET) и `/api/export-docx` (POST). Systemd-юнит `mdviewer-export.service`.
- **Менять лимиты** — константы `FETCH_MAX_BYTES`, `FETCH_TIMEOUT_MS`, `FETCH_MAX_REDIRECTS`, `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX` в начале файла.
- **Расширить blocklist** — объект `ipBlockList` (например, добавить публичные DNS-серверы провайдера, если они в приватном диапазоне).
- **Разрешить конкретный приватный хост** (например, внутренний storage за VPN): добавьте bypass-проверку в `resolveAndCheck` по whitelist имён хостов.
- **CSP**: `connect-src` должен включать `'self'` (запросы на `/api/fetch` same-origin). Для изображений: `img-src` должен явно перечислять разрешённые источники картинок.
- **После правок бэкенда:** `systemctl restart mdviewer-export`, для nginx — `nginx -t && systemctl reload nginx`.

### Деплой backend

См. раздел «Экспорт в DOCX» ниже — это тот же Node.js-сервис на `127.0.0.1:3001`. Обновление кода:

```bash
sudo cp backend/server.js /home/admin/web/<domain>/private/backend/server.js
sudo systemctl restart mdviewer-export
curl -sI "https://<viewer-domain>/api/fetch?url=https://example.com/" | head -1   # HTTP/2 200
```

## Экспорт в DOCX

В шапку добавлена кнопка «.docx» (рядом с переключателем темы). Она активна только когда:
- загружен Markdown-файл,
- настроен и запущен backend-эндпоинт `/api/export-docx`.

### Архитектура экспорта
- **Frontend** (`index.html`): перед отправкой исходный Markdown проходит front-end препроцессинг:
  - относительные URL изображений резолвятся в абсолютные,
  - блоки `` \`\`\`mermaid `` и `` \`\`\`pikchr `` заменяются на встроенные SVG в Base64,
  - блоки `` \`\`\`plantuml `` заменяются на `![PlantUML](plantuml_url)`.
- **Backend** (`private/backend/server.js`): лёгкий Node.js HTTP-сервер (zero-зависимостей). Принимает JSON `{ markdown, filename }`, запускает `pandoc -f gfm -t docx --wrap=none`, обрабатывает `data:` URI изображений (пишет во временные файлы) и отдаёт готовый `.docx`.
- **Nginx** (`nginx.ssl.conf_export_docx`): location `/api/` проксируется на `127.0.0.1:3001`.

### Требования к серверу
- `pandoc` >= 3.x (или 2.9.2+). Рекомендуется свежий `.deb` с GitHub Releases.
- `node` >= 18.
- systemd (для запуска backend-как-сервиса).

### Быстрый деплой backend на HestiaCP
```bash
# 1. Установить pandoc
wget https://github.com/jgm/pandoc/releases/download/3.10/pandoc-3.10-1-amd64.deb
sudo dpkg -i pandoc-3.10-1-amd64.deb

# 2. Скопировать backend
sudo mkdir -p /home/admin/web/report.insightpilot.ru/private/backend
sudo cp private/backend/* /home/admin/web/report.insightpilot.ru/private/backend/

# 3. Systemd
sudo cp /path/to/mdviewer-export.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now mdviewer-export

# 4. Nginx include
sudo cp /path/to/nginx.ssl.conf_export_docx /home/admin/conf/web/report.insightpilot.ru/
sudo nginx -t && sudo systemctl reload nginx
```

## Деплой

Приложение — это статический `index.html` + каталог `vendor/`. Минимальный вариант деплоя на любой веб-сервер:

```bash
# 1. Создать document root и скопировать статику
sudo mkdir -p /var/www/file-viewer
sudo cp index.html vendor -t /var/www/file-viewer/
sudo chown -R <web-server-user>:<web-server-user> /var/www/file-viewer

# 2. Настроить server block (см. раздел для вашей системы выше)
# 3. Проверить и перезагрузить веб-сервер
sudo <web-server> -t && sudo systemctl reload <web-server>

# 4. Проверить, что index.html и vendor/ отдаются
curl -sI "https://<viewer-domain>/index.html"        | head -1   # HTTP/2 200
curl -sI "https://<viewer-domain>/vendor/marked.min.js" | head -1   # HTTP/2 200
```

Особенности для LLM-агента:
- **Не** кладите `index.html` в подкаталог — приложение использует относительные пути к `vendor/`.
- Проверьте, что MIME-тип для `.js` отдаётся как `application/javascript` (или `text/javascript`), иначе браузер заблокирует исполнение.
- Если страница грузится пустой — откройте DevTools → Console. Самые частые причины: 404 на `vendor/*.js` (неправильный document root) или CSP-заголовок, блокирующий `script-src`.

## Структура проекта

```
.
├── index.html              # одностраничное приложение (HTML + CSS + JS в одном файле)
├── backend/
│   ├── server.js           # Node.js: /api/fetch (SSRF-safe proxy) + /api/export-docx (pandoc)
│   └── package.json
├── vendor/                 # самохостящиеся библиотеки (см. таблицу выше)
│   ├── marked.min.js
│   ├── highlight.min.js
│   ├── hljs-dark.css
│   ├── hljs-light.css
│   ├── mermaid.min.js
│   └── pikchr.js
├── mdviewer-export.service # systemd-юнит для backend
└── README.md
```
