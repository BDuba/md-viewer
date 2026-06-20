# File Viewer

Одностраничный просмотрщик Markdown (`.md`) и JSON (`.json`) файлов по URL или из локального файла. Поддерживает подсветку синтаксиса, переключение светлой/тёмной темы, компактный режим, а также рендеринг диаграмм Mermaid, PlantUML, Pikchr и внешних SVG (draw.io).

Открывается по адресу вида:

```
https://report.insightpilot.ru/?url=https://example.com/file.md
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

## CORS-прокси для хранилища

Браузер по умолчанию блокирует `fetch()` к доменам, которые не отдают заголовок `Access-Control-Allow-Origin`. Если Markdown-файлы лежат на домене без настроенного CORS (например, объектный storage VK Cloud), приложение не сможет их загрузить напрямую.

Чтобы обойти это, на хосте `report.insightpilot.ru` настроен nginx-прокси `location /storage/`, который форвардит запросы на `insightpilot.hb.ru-msk.vkcloud-storage.ru` и добавляет CORS-заголовки в ответ. Фронтенд автоматически использует этот прокси (через функцию `ownProxy()` в `index.html`) для любых URL, оканчивающихся на `.vkcloud-storage.ru`.

### Установка прокси (HestiaCP)

Файл `nginx.ssl.conf_storage_proxy` кладётся в каталог конфига домена:

```
/home/admin/conf/web/report.insightpilot.ru/
├── nginx.ssl.conf                  # управляется HestiaCP (не править вручную)
├── nginx.conf                      # управляется HestiaCP (не править вручную)
└── nginx.ssl.conf_storage_proxy    # ← наш custom-файл
```

Содержимое `nginx.ssl.conf_storage_proxy`:

```nginx
# CORS proxy for VK Cloud Storage — survives HestiaCP rebuilds via include pattern
location /storage/ {
    # Handle CORS preflight
    if ($request_method = 'OPTIONS') {
        add_header Access-Control-Allow-Origin '*' always;
        add_header Access-Control-Allow-Methods 'GET, OPTIONS' always;
        add_header Access-Control-Allow-Headers '*' always;
        add_header Access-Control-Max-Age 86400 always;
        add_header Content-Length 0;
        return 204;
    }

    proxy_pass https://insightpilot.hb.ru-msk.vkcloud-storage.ru/;
    proxy_set_header Host insightpilot.hb.ru-msk.vkcloud-storage.ru;
    proxy_ssl_server_name on;
    proxy_ssl_name insightpilot.hb.ru-msk.vkcloud-storage.ru;

    # Strip CORS headers from upstream (if any) and add our own
    proxy_hide_header Access-Control-Allow-Origin;
    proxy_hide_header Access-Control-Allow-Methods;
    add_header Access-Control-Allow-Origin '*' always;
}
```

HestiaCP-конфиг домена (`nginx.ssl.conf`) уже содержит include, подхватывающий файлы по маске `nginx.ssl.conf_*`, так что отдельный `include` добавлять не нужно:

```nginx
include /home/admin/conf/web/report.insightpilot.ru/nginx.ssl.conf_*;
```

После создания файла — проверка и reload:

```bash
nginx -t && systemctl reload nginx
```

### Настройка на другом домене / другом хранилище

1. Заменить `insightpilot.hb.ru-msk.vkcloud-storage.ru` в `proxy_pass`, `proxy_set_header Host` и `proxy_ssl_name` на свой домен.
2. Если несколько доменов storage — продублировать `location` или использовать `map` в nginx.
3. В `index.html` обновить регулярку в `ownProxy()`:

   ```js
   function ownProxy(url) {
     const m = String(url).match(/^https?:\/\/[^/]*\.vkcloud-storage\.ru\/(.*)$/);
     if (m) return '/storage/' + m[1];
     return url;
   }
   ```

### Запуск без своего прокси

Приложение работает и без `location /storage/`, но тогда загрузка файлов с доменов без CORS будет полагаться на внешние публичные прокси (`cors.eu.org`, `api.allorigins.win`). Они **ненадёжны**: периодически возвращают 5xx, редиректят на посторонние сайты или висят. Для production-использования настройка собственного прокси настоятельно рекомендуется.

## Деплой

Приложение — это статический `index.html` + каталог `vendor/`. На текущем сервере раскатка выглядит так:

```bash
# из корня репозитория
cp index.html /home/admin/web/report.insightpilot.ru/public_html/index.html
cp -r vendor /home/admin/web/report.insightpilot.ru/public_html/
chown -R admin:admin /home/admin/web/report.insightpilot.ru/public_html/
```

HestiaCP отдаёт статику напрямую через nginx (location для статики с `root .../public_html`), Apache используется только как fallback для PHP/динамики.

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
