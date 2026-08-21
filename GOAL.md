# 🎯 GOAL: ai-docs-terminal — до готового продукта

*(живой handoff-док: обновляется по ходу — статус, коррекция фактов, что идёт автономно)*

## Цель одной строкой
Рабочий open-source продукт: встраиваемый AI-терминал для документации (`<DocsTerminal>`) — монорепо с ядром, бекендами, react-обёрткой, docusaurus-интеграцией и живой демо-страницей, верифицированный тестами и playwright-скриншотами, готовый к `npm publish` (сам publish — за Максимом).

## Критерий готовности (проверяемый!) — ✅ ВСЕ ПУНКТЫ ЗАКРЫТЫ 2026-08-21
- [x] `pnpm -r build` зелёный во всех пакетах (входит в `pnpm test`)
- [x] `pnpm typecheck` зелёный (6/6 workspace, tsc 7), `vitest run` 49/49 (9 файлов)
- [x] демо-страница: playwright e2e реально бутает pyodide и выполняет python (`print("sum:", 6*7)` → `sum: 42`, `1/0` → ZeroDivisionError); скриншоты light/dark сняты и просмотрены
- [x] mock-бекенд: скриптованный orbit-туториал проходит в демо (e2e: init/destroy/127-fallback)
- [x] AI-слой: `#deploy the app` → suggestion → y → выполнение; `explain` после ошибки стримит текст — оба флоу в playwright (`?ai=mock`), отмена по n тоже
- [x] контекст страницы в системном промпте (юнит: system содержит title страницы; SessionController передаёт context+history)
- [x] react-обёртка рендерит/mount/dispose (тесты)
- [x] docusaurus-интеграция: `docs/embedding.md` с рабочим MDX-рецептом (BrowserOnly) + react + vanilla/vite
- [x] README.md (EN) + README.ru.md (RU); MEMORY_BANK/ заведён (6 файлов) и в .gitignore
- [x] финальный отчёт ниже

## Scope и источники
- Входит: `~/Projects/Personal/ai-docs-terminal/` целиком (монорепо строится здесь)
- Спека: README.md + TODO.md проекта (ресерч 2026-07-11)
- НЕ входит: npm publish, show hn/product hunt, платный cloud, vue/svelte/solid-обёртки, ws-бекенд, vitepress/starlight/mintlify-плагины (фаза-2+, после launch-решения Максима)
- nodepod-бекенд: решение по итогам фазы 0 (зрелость неизвестна); pyodide — гарантированный первый бекенд

## 🚫 Неприкасаемое
- другие папки в `~/Projects/Personal/` не трогать (browser-ai-polyfill уже удалён по явной команде 2026-08-20)
- git: НЕ коммитить и НЕ пушить без явной команды (feedback_no_autocommit)
- ничего не публиковать наружу (npm/github) — только локальная сборка
- системные конфиги/диски — не трогать

## Правила выполнения (из памяти)
- feedback_bilingual_text_everywhere: доки парные EN+RU; UI-строки виджета через каталог сообщений (en дефолт, ru каталог); идентификаторы только английские
- feedback_no_code_comments_memory_bank: без пояснительных комментариев в коде; «почему» — в MEMORY_BANK/ (6 файлов Cline-структуры, в .gitignore)
- verify-before-claim-done: tsc + vitest + playwright скриншот/snapshot перед любым «готово»; iterate до clean или 3 попытки → честная эскалация
- Karpathy: simplicity first (минимум кода под MVP, без speculative abstractions), surgical changes, spec > vibe (спека api виджета до кода)
- параллелить ожидания (ставится pyodide → пишется mock/core)

## Нотификации (вместо «ну что?»)
- по завершении фазы / блокеру / финалу — `~/scripts/notify-maxim.sh`
- статус живёт здесь, секция «ЧТО СЕЙЧАС ИДЁТ»

## Формат финального отчёта
- было→стало (пакеты, тесты, скриншоты), что отложено + причины, открытые вопросы списком

---
## ⚡ КОРРЕКЦИЯ ФАКТОВ (по ходу)
- 2026-08-20: ниши конкурентов перепроверены — chrome выпустил свой prompt-api polyfill (browser-ai-polyfill мёртв, удалён), webmcp-инспекторов уже 7; ниша ai-docs-terminal пуста — подтверждено

## ЧТО УЖЕ СДЕЛАНО ✅
- GOAL-файл заведён (2026-08-20 23:07)
- фаза 0 завершена: nodepod в npm НЕТ (бекенд отложен), browserpod проприетарный (мимо), pyodide 314.0.5 MPL-2.0 ок, xterm 6.0.0, имя docsterm/@docsterm свободно; toolchain node 24 + pnpm 11.22
- AI-контракт зафиксирован (claude-api skill): @anthropic-ai/sdk + dangerouslyAllowBrowser, model default claude-opus-5, structured outputs для suggest, streaming для explain, refusal guard
- ПЛАН НАПИСАН: `docs/superpowers/plans/2026-08-20-docsterm-mvp.md` — 10 задач (T0 scaffold → T9 docs+verify), контракты типов, спека поведения SessionController (10 правил)
- browser-ai-polyfill удалён по команде Максима (ниша закрыта хромом)

## ЧТО СЕЙЧАС ИДЁТ (автономно)
- ничего — кампания завершена 2026-08-21 ~01:15

## ФИНАЛЬНЫЙ ОТЧЁТ (2026-08-21)

**Было** (старт 2026-08-20 23:07): папка с README-ресерчем и TODO, ноль кода.

**Стало**: рабочий продукт docsterm v0.1 — pnpm-монорепо, 5 библиотек + демо:
- `docsterm` — xterm.js виджет; чистые LineEditor + SessionController (вся логика под юнитами), i18n en/ru, темы, page-context, keyStore, mock-AI
- `docsterm-backend-mock`, `docsterm-backend-pyodide` (Python 3.14 в браузере, CDN lazy)
- `docsterm-ai-anthropic` — official SDK, byok, structured outputs + streaming, refusal guard, model default claude-opus-5
- `docsterm-react` — компонент
- `demo/` — доки вымышленного CLI orbit: mock-туториал, python-туториал, `?ai=mock`, настройки ключа, locale/theme

**Verification log**: tsc 6/6 workspace зелёный · vitest 49/49 · playwright 7/7 (в т.ч. живой pyodide: print → `sum: 42`, ZeroDivisionError; AI suggest→y→run; explain-стрим; отмена; ru-локаль) · скриншоты `e2e/screenshots/demo-{light,dark}.png` просмотрены — рендер чистый в обеих темах.

**Отложено сознательно** (см. TODO.md): npm publish (за Максимом; scope @docsterm свободен), docusaurus-плагин-пакет (встраивание задокументировано в docs/embedding.md), vue/svelte, node/ws-бекенды (nodepod не существует в npm, browserpod проприетарный), step-engine, launch-активности.

**Грабли по ходу** (детали в MEMORY_BANK/techContext.md): vitest 4 убрал workspace-файл → test.projects; vite 8 (rolldown) требует прямой dep @xterm/xterm в демо для css-резолва; порт 4173 был занят чужим preview (LiquidGlassJs) → e2e на 4179 c reuseExistingServer:false; jsdom: innerHTML head затирает title.

**Открытые вопросы Максиму**: 1) публикуем в npm? 2) выносить из Personal в отдельный репо под github? 3) нужен ли деплой демо (vercel/pages) для показа?
