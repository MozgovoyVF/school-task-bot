# school-task-bot («Секретарь школы»)

Telegram-бот для руководителя школы французского языка. Бот молча читает рабочие группы, с помощью LLM
находит поручения, договорённости и события, а также сообщения о выполнении, переносе и отмене задач.
Руководителю в личный чат приходят карточки-предложения с кнопками; бот ведёт задачи, напоминает о
сроках и каждое утро присылает сводку.

## Документация

- [`SPEC.md`](./SPEC.md) — спецификация, единственный источник бизнес-правил.
- [`plan.md`](./plan.md) — пошаговый план реализации по фазам и задачам.
- [`CLAUDE.md`](./CLAUDE.md) — правила работы и соглашения по коду для агентов.

## Команды

```bash
corepack enable                       # один раз: pnpm из packageManager в package.json
pnpm install
pnpm db:up                            # Postgres 17 для разработки и тестов (docker/compose.dev.yml, порт 5433)
pnpm dev                              # tsx watch src/index.ts (нужен .env)
pnpm lint | pnpm format | pnpm format:check | pnpm typecheck
pnpm test                             # unit + integration (нужен pnpm db:up)
pnpm test:unit                        # только unit, без БД
pnpm test:int                         # только integration
pnpm coverage                         # покрытие domain/ и ai/pipeline/ ≥ 80%
pnpm db:generate                      # drizzle-kit: SQL-миграция из изменений схемы
pnpm db:migrate                       # применить миграции к DATABASE_URL
pnpm build && pnpm start              # сборка в dist/ и запуск
pnpm eval --model <id> --limit 20     # РЕАЛЬНЫЙ API, стоит денег — только с разрешения пользователя
docker compose -f docker/compose.yml -p stb-dev up -d   # как на сервере
```

Для тестов нужна переменная `TEST_DATABASE_URL`, по умолчанию `postgres://stb:stb@localhost:5433/stb_test`.
