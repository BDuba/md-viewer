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

## CORS-прокси для источника файлов

### Зачем нужен

Браузер по умолчанию блокирует `fetch()` к доменам, которые не отдают заголовок `Access-Control-Allow-Origin`. Если Markdown-файлы лежат на домене без настроенного CORS (объектный storage, внутренний HTTP-сервер, GitHub raw с авторизацией и т. п.), приложение не сможет их загрузить напрямую.

Чтобы обойти это, на хосте приложения настраивают обратный прокси (например, `location /storage/`), который:

1. Форвардит запросы на upstream-домен с файлами.
2. Добавляет CORS-заголовки в ответ (`Access-Control-Allow-Origin: *`).
3. Отвечает на preflight `OPTIONS` 204-м статусом.

Фронтенд автоматически использует этот прокси для доменов, попадающих под regex в функции `ownProxy()` в `index.html` (см. раздел «Адаптация под свой storage»).

### Что важно для LLM-агента

- **Прокси опционален.** Приложение работает и без него, но полагается на внешние публичные CORS-прокси (`cors.eu.org`, `api.allorigins.win`), которые периодически падают/редиректят. Для production-инсталляции прокси **обязателен**.
- **Домен приложения и домен storage могут совпадать.** Прокси всё равно полезен: он централизованно добавляет CORS и не зависит от настроек upstream.
- **Прокси НЕ должен быть open** (проксировать произвольные URL во весь интернет). Ограничивайте upstream конкретным хостом. Все конфиги ниже следуют этому правилу.
- **Путь `/storage/` захардкожен во фронте.** Если меняете путь — правьте `PROXIES` в `index.html`.
- **После любых правок конфига:** `nginx -t` (или аналог), затем reload, затем `curl -I` для проверки `access-control-allow-origin`.

### Шаблон nginx-конфига (заменить `<storage-domain>`)

```nginx
# CORS proxy for upstream storage — add as a `location /storage/` block
# inside the `server { ... }` that serves the viewer.
location /storage/ {
    # CORS preflight
    if ($request_method = 'OPTIONS') {
        add_header Access-Control-Allow-Origin '*' always;
        add_header Access-Control-Allow-Methods 'GET, OPTIONS' always;
        add_header Access-Control-Allow-Headers '*' always;
        add_header Access-Control-Max-Age 86400 always;
        add_header Content-Length 0;
        return 204;
    }

    proxy_pass https://<storage-domain>/;
    proxy_set_header Host <storage-domain>;
    proxy_ssl_server_name on;
    proxy_ssl_name <storage-domain>;

    # Strip CORS headers from upstream (if any) and add our own
    proxy_hide_header Access-Control-Allow-Origin;
    proxy_hide_header Access-Control-Allow-Methods;
    add_header Access-Control-Allow-Origin '*' always;
}
```

Если upstream по HTTP (не HTTPS), замените `proxy_pass https://...` на `http://...` и удалите строки `proxy_ssl_*`.

### Развёртывание на разных системах

#### Plain nginx (Ubuntu/Debian/CentOS/Alpine)

1. Положить статику в document root:

   ```bash
   sudo mkdir -p /var/www/file-viewer
   sudo cp index.html vendor -t /var/www/file-viewer/
   sudo chown -R nginx:nginx /var/www/file-viewer   # или www-data на Debian/Ubuntu
   ```

2. Создать server block (например, `/etc/nginx/conf.d/file-viewer.conf` на Debian/Ubuntu или `/etc/nginx/conf.d/file-viewer.conf` на RHEL/Alpine):

   ```nginx
   server {
       listen 443 ssl http2;
       server_name <viewer-domain>;

       ssl_certificate     /etc/letsencrypt/live/<viewer-domain>/fullchain.pem;
       ssl_certificate_key /etc/letsencrypt/live/<viewer-domain>/privkey.pem;

       root /var/www/file-viewer;
       index index.html;

       location /storage/ {
           # … вставить шаблон из раздела выше …
       }

       location / { try_files $uri $uri/ =404; }
   }
   ```

3. Проверить и перезагрузить:

   ```bash
   sudo nginx -t && sudo systemctl reload nginx
   ```

4. Верификация:

   ```bash
   curl -sI "https://<viewer-domain>/storage/some-file.md" | grep -i access-control
   # Ожидается: access-control-allow-origin: *
   ```

Особенности для LLM-агента:
- document root в Debian/Ubuntu по умолчанию `/var/www/html`, пользователь `www-data`.
- в RHEL/Alpine — `/usr/share/nginx/html`, пользователь `nginx`.
- HTTPS обычно через Let's Encrypt (`certbot --nginx -d <viewer-domain>`).

#### HestiaCP

HestiaCP управляет конфигами домена сам — **нельзя редактировать `nginx.ssl.conf`/`nginx.conf` напрямую** (перетрутся при ребилде). Вместо этого используются include-файлы по маске `nginx.ssl.conf_*`.

1. Положить статику в document root домена:

   ```bash
   DOMAIN=<viewer-domain>
   DOCROOT=/home/<user>/web/$DOMAIN/public_html
   sudo cp index.html vendor -t "$DOCROOT/"
   sudo chown -R <user>:<user> "$DOCROOT"
   ```

2. Создать файл `/home/<user>/conf/web/$DOMAIN/nginx.ssl.conf_storage_proxy` с шаблоном `location /storage/` (из раздела выше). HestiaCP-конфиг домена уже содержит инклуд:

   ```nginx
   include /home/<user>/conf/web/$DOMAIN/nginx.ssl.conf_*;
   ```

   — отдельный include добавлять не нужно.

3. Проверить и перезагрузить:

   ```bash
   sudo nginx -t && sudo systemctl reload nginx
   ```

Особенности для LLM-агента:
- Имя пользователя HestiaCP обычно `admin` (см. `v-list-users`).
- Список доменов: `v-list-web-domains <user>`.
- Document root домена: `v-list-web-domain <user> <domain> | grep DOCUMENT_ROOT`.
- HestiaCP на некоторых шаблонах проксирует статику через Apache (`:8443`); это не мешает добавить свой `location /storage/` — он сработает до fallback.
- Если HestiaCP пересоберёт домен (`v-rebuild-web-domains`), include-файлы по маске сохранятся, а правки в `nginx.ssl.conf` — нет.

#### Caddy

Caddy автоматически выпускает HTTPS и не требует отдельной настройки сертификатов.

`Caddyfile`:

```caddy
<viewer-domain> {
    root * /var/www/file-viewer
    file_server

    handle_path /storage/* {
        reverse_proxy https://<storage-domain> {
            header_up Host <storage-domain>
            transport http {
                tls_server_name <storage-domain>
            }
        }
        header {
            Access-Control-Allow-Origin "*"
            Access-Control-Allow-Methods "GET, OPTIONS"
            Access-Control-Allow-Headers "*"
            Access-Control-Max-Age "86400"
        }
    }
}
```

Перезагрузка:

```bash
sudo systemctl reload caddy
```

Особенности для LLM-агента:
- `handle_path` (а не `handle`) срезает префикс `/storage/` — upstream получает путь без него.
- Для preflight `OPTIONS` Caddy автоматически ответит 204, если в `header` прописаны CORS-заголовки.
- Конфиг-файл по умолчанию: `/etc/caddy/Caddyfile`.

#### Apache + mod_proxy

Менее желательно (медленнее nginx/Caddy), но работает, если Apache уже стоит.

```apache
<VirtualHost *:443>
    ServerName <viewer-domain>

    DocumentRoot /var/www/file-viewer
    SSLEngine on
    SSLCertificateFile     /etc/letsencrypt/live/<viewer-domain>/fullchain.pem
    SSLCertificateKeyFile  /etc/letsencrypt/live/<viewer-domain>/privkey.pem

    # CORS headers
    Header set Access-Control-Allow-Origin "*"
    Header set Access-Control-Allow-Methods "GET, OPTIONS"
    Header set Access-Control-Allow-Headers "*"

    # Handle preflight
    RewriteEngine On
    RewriteCond %{REQUEST_METHOD} OPTIONS
    RewriteRule ^(.*)$ $1 [R=204,L]

    # Proxy /storage/ to upstream
    SSLProxyEngine on
    ProxyPass        /storage/ https://<storage-domain>/
    ProxyPassReverse /storage/ https://<storage-domain>/
    ProxyPreserveHost Off
    RequestHeader set Host <storage-domain>
</VirtualHost>
```

Включить модули и перезагрузить:

```bash
sudo a2enmod ssl headers rewrite proxy proxy_http
sudo systemctl reload apache2
```

Особенности для LLM-агента:
- В Debian/Ubuntu: `apache2`, в RHEL: `httpd`.
- `ProxyPass` требует `mod_proxy` и `mod_proxy_http` (или `_ssl` для HTTPS upstream).
- При trailing `/` в `ProxyPass` префикс `/storage/` срезается автоматически.

#### Static hosting (Netlify, Vercel, GitHub Pages, Cloudflare Pages)

На этих платформах **нельзя** запустить nginx/Apache прокси. Два варианта:

1. **Без прокси** — приложение работает только с sources, у которых уже настроен CORS, либо через публичные прокси (ненадёжно).

2. **Edge Function / Redirect с CORS-заголовками** — у Netlify и Vercel есть серверлесс-функции, можно написать прокси на JS. Пример для Netlify (`netlify/functions/storage.js`):

   ```js
   export default async (req) => {
     const url = new URL(req.url).searchParams.get('url');
     if (!url || !url.startsWith('https://<storage-domain>/')) {
       return new Response('Bad url', { status: 400 });
     }
     const upstream = await fetch(url);
     const headers = new Headers(upstream.headers);
     headers.set('Access-Control-Allow-Origin', '*');
     return new Response(upstream.body, { status: upstream.status, headers });
   };
   ```

   Тогда `ownProxy()` во фронте должен возвращать `/.netlify/functions/storage?url=<encoded>`.

Особенности для LLM-агента:
- Cloudflare Pages поддерживает `_redirects` и Workers (отдельный прокси через Worker проще, чем Pages Functions для этой задачи).
- GitHub Pages вообще не поддерживает серверный код — только вариант 1 или вынос прокси на другой хост.

### Адаптация под свой storage

Во фронте (`index.html`) за маршрутизацию на прокси отвечает функция `ownProxy()`. По умолчанию она сопоставляет URL с regex'ом для конкретного storage-домена и при совпадении переписывает путь на `/storage/<...>`. Перед деплоем **убедитесь, что regex в `index.html` указывает на ваш storage-домен** (или список доменов).

Пример реализации под один домен `files.example.com`:

```js
function ownProxy(url) {
  const m = String(url).match(/^https?:\/\/files\.example\.com\/(.*)$/);
  if (m) return '/storage/' + m[1];
  return url;
}
```

Для поддомена с wildcard (например, `<bucket>.storage.example.com`):

```js
const m = String(url).match(/^https?:\/\/[^/]*\.storage\.example\.com\/(.*)$/);
```

Для нескольких доменов:

```js
function ownProxy(url) {
  const STORAGE_HOSTS = ['files.example.com', 'cdn.example.org'];
  try {
    const u = new URL(url);
    if (STORAGE_HOSTS.includes(u.hostname)) {
      return '/storage/' + u.hostname + u.pathname.slice(1) + u.search;
    }
  } catch (e) {}
  return url;
}
```

(в последнем варианте nginx-конфиг должен уметь выбирать upstream по пути — проще оставить отдельный префикс на домен: `/storage-files/`, `/storage-cdn/` и т. д.)

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
├── vendor/                 # самохостящиеся библиотеки (см. таблицу выше)
│   ├── marked.min.js
│   ├── highlight.min.js
│   ├── hljs-dark.css
│   ├── hljs-light.css
│   ├── mermaid.min.js
│   └── pikchr.js
└── README.md
```
