# Handoff: независимый review DeepSeek provider adapter

## Цель

Провести независимый **read-only** review ветки с адаптером paid-провайдера для
Agent Workflow Kit. Нужен честный verdict `APPROVE`, `WARN` или `BLOCK`: не
переписывать задачу и не подтверждать качество по этому файлу на слово.

## Точка проверки

- Репозиторий: `/Users/maksim/Developer/agent-workflow-kit`
- Ветка: `feat/deepseek-provider-adapter`
- Проверяемый HEAD: `3b471c442a6be8039e9980789122d1b0886b85fc`
- База: `58f3039` (`main`)
- Рабочее дерево на момент handoff: чистое.
- Ветка локальная; ничего не опубликовано и не включено в production.

## Контекст и границы

Kit по умолчанию работает через локальный Codex CLI и подписку. Адаптер добавляет
только opt-in paid HTTP-маршрут `deepseek`; он не является переносом всей системы
на DeepSeek и не меняет production-конфигурацию другого репозитория.

Проверяемый маршрут может отправить сырой текст prompt/команды внешнему API. Для
него одновременно нужны:

1. выбранный provider для конкретного profile;
2. `DEEPSEEK_API_KEY` в окружении;
3. `AGENT_KIT_ALLOW_EXTERNAL_PROMPTS=1`;
4. подтверждённые цены модели;
5. положительный ceiling бюджета.

При отсутствии любого из этих условий вызов должен не уйти к paid-провайдеру и
явно эскалировать на Codex-подписку. Не добавлять ключи, не выполнять реальный
paid API-вызов и не менять env в ходе review.

## Проверяемые файлы

- `templates/claude/hooks/providers.js`
- `templates/claude/hooks/ledger.js`
- `templates/claude/hooks/codex-copilot.js`
- `tests/providers.test.js`
- `tests/ledger.test.js`
- `tests/codex-copilot.test.js`
- `README.md`

## Что уже сделано и что нужно перепроверить

1. **Default-safe routing:** неизвестный provider и отсутствие route возвращают
   Codex, а не HTTP provider; prototype-имена не должны обойти allowlist.
2. **Передача данных:** paid-route не вызывает transport без точного
   `AGENT_KIT_ALLOW_EXTERNAL_PROMPTS=1`.
3. **Бюджет:** цена валидна только если обе компоненты конечные, неотрицательные
   и их сумма положительна. Отсутствующая/сломанная цена — это неизвестный расход,
   а не `$0`.
4. **Гонка бюджета:** worst-case сумма резервируется до HTTP-вызова атомарно.
   Два параллельных запроса, каждый из которых помещался бы в лимит отдельно,
   не могут превысить лимит вместе. Упавший процесс оставляет резерв консервативно.
5. **Учёт:** после измеренного ответа резерв сводится к факту; ответ без usage
   считается непроверяемым, ответ отбрасывается и резерв остаётся.
6. **Формат решения:** разрешены только `APPROVE`/`WARN`/`BLOCK`; самый строгий
   verdict выигрывает; strict-mode должен deny только на `BLOCK`.
7. **Ошибки:** API-key / Bearer / token-shaped текст не должен попасть из transport
   error в Claude hook output.
8. **Документация:** README не обещает работу с consumer-подпиской DeepSeek и
   описывает фактический внешний API, privacy-условие и лимит.

## Команды проверки

```bash
cd /Users/maksim/Developer/agent-workflow-kit
git status --short
git diff --check 58f3039..3b471c4
node --test tests/*.test.js
./scripts/smoke-test.sh
./scripts/scrub-check.sh
```

Ожидаемо: 45 tests pass; smoke и scrub зелёные. Все эти проверки без сети и без
ключей.

## Специальные adversarial вопросы

- Может ли `constructor`, `__proto__` или иной prototype key открыть paid route?
- Может ли цена `-1`, `NaN`, строка либо `{in: 0, out: 0}` пропустить budget gate?
- Есть ли путь, где paid-call стартует без transfer acknowledgement?
- Может ли параллельный запуск превысить ceiling до записи в ledger?
- Не double-count ли reservation при success, parse-error, missing usage и HTTP failure?
- Может ли raw error показать секрет в `additionalContext`?
- Нет ли обхода strict deny через markdown или `BLOCK - reason`?

## Внешние, не закрываемые кодом условия

- Живой DeepSeek/API smoke не запускался: это намеренно, чтобы не тратить деньги
  и не отправлять рабочий контекст без согласования.
- До включения владелец должен отдельно подтвердить допустимость передачи prompt и
  команд внешнему vendor, актуальные model prices и ceiling.
- Реальный ответ/usage конкретного vendor нужно проверить в изолированном
  не-чувствительном pilot после этих решений.

## Формат ответа

Начать с `APPROVE`, `WARN` или `BLOCK`. Для каждого finding указать severity,
файл и строку, воспроизведение/доказательство и минимальное исправление. Если
finding нет — явно написать, что именно запускалось, и перечислить внешние
ограничения выше. Не коммитить, не пушить и не менять provider/env.
