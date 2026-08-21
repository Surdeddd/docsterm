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

## Дальше (за пределами v0.1)

- [ ] npm publish (@docsterm scope свободен) — за Максимом
- [ ] пошаговый режим туториала: массив шагов (текст + ожидаемая команда + валидация вывода)
- [ ] docusaurus-плагин-пакет + vue/svelte-обёртки
- [ ] node-бекенд, когда появится зрелая MIT-песочница (nodepod следить: https://scelar.com/blog/introducing-nodepod)
- [ ] ws-бекенд для docker/k8s сценариев
- [ ] лимит llm-вызовов + csp-гайд расширенный
- [ ] launch: show hn / product hunt / письма mintlify, gitbook, starlight
- [ ] (опция) платный тир: аналитика застреваний
