# TODO — ai-docs-terminal

Статус: v0.1 реализован 2026-08-21 (план: `docs/superpowers/plans/2026-08-20-docsterm-mvp.md`, отчёт: `GOAL.md`).

## Сделано (v0.1)

- [x] фаза 0: ресерч подтверждён (ниша пуста), nodepod мёртв → бекенды pyodide + mock, лицензии проверены, имя docsterm свободно
- [x] монорепо pnpm: `docsterm`, `docsterm-react`, `docsterm-backend-mock`, `docsterm-backend-pyodide`, `docsterm-ai-anthropic`
- [x] core: xterm.js + line editor + SessionController (чистая логика под юнит-тестами), i18n en/ru, темы light/dark/auto
- [x] backend-mock: скриптованные команды, fallback 127, задержки, banner
- [x] backend-pyodide: ленивый Pyodide с CDN, stdout/stderr capture, чистка трейсбеков
- [x] AI-слой: `#запрос` → suggest (structured outputs) → подтверждение y/N → запуск; `explain` стримом; byok в localStorage
- [x] контекст страницы (title/description/headings) в системный промпт
- [x] react-обёртка
- [x] демо-сайт (vite): доки вымышленного cli orbit, mock + python туториалы, `?ai=mock`, настройки ключа, locale/theme переключатели
- [x] verify: tsc + vitest (49) + playwright e2e (7, включая живой pyodide) + скриншоты light/dark
- [x] README.md (EN) + README.ru.md + docs/embedding.md (docusaurus/react/vanilla)

## Сделано после v0.1 (2026-08-21, по «да» Максима)

- [x] отдельный репо: https://github.com/Surdeddd/docsterm (public, main)
- [x] демо задеплоено: https://docsterm.vercel.app (vercel, static prod; проверено headless-хромом — виджет исполняет команды)

## v0.2.0 (2026-08-21, по замечаниям Максима)

- [x] **один пакет вместо пяти**: `docsterm` + под-импорты `docsterm/mock`, `docsterm/pyodide`, `docsterm/anthropic`, `docsterm/react`. pyodide / @anthropic-ai/sdk / react — опциональные peer'ы (проверено чистой установкой: `npm i docsterm` тянет только @xterm). Старые 4 пакета помечены deprecated со ссылкой на новый.
- [x] **редизайн демо**: типографский спек-лист (Instrument Serif + JetBrains Mono, печать «в две краски»), сетка с §-маркерами, зерно, staggered-анимации, светлая/тёмная тема
- [x] **страница целиком двуязычная**: один переключатель меняет текст страницы, язык виджета, `<title>` и meta-description (а значит и контекст, который видит AI). Каталог `demo/src/i18n.ts`, без склеек языков
- [x] подпись автора: футер «built by / сделал Surdeddd», `author` в package.json, MIT © Surdeddd в README
- [x] **баг ядра пойман тестом**: бесконечный цикл ResizeObserver ↔ FitAddon (в чужих доках жёг бы CPU) — RO-колбэк теперь сравнивает предложенные размеры с текущими; плюс терминал не растягивается по содержимому
- [x] опции виджета: `fontFamily`, `fontSize`, `theme` принимает объект темы

## Дальше (за пределами v0.1)

- [ ] пошаговый режим туториала: массив шагов (текст + ожидаемая команда + валидация вывода)
- [ ] docusaurus-плагин-пакет + vue/svelte-обёртки
- [ ] node-бекенд, когда появится зрелая MIT-песочница (nodepod следить: https://scelar.com/blog/introducing-nodepod)
- [ ] ws-бекенд для docker/k8s сценариев
- [ ] лимит llm-вызовов + csp-гайд расширенный
- [ ] launch: show hn / product hunt / письма mintlify, gitbook, starlight
- [ ] (опция) платный тир: аналитика застреваний
