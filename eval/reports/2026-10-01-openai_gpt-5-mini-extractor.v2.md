# Eval report: openai/gpt-5-mini / extractor.v2

- Date: 2026-10-01
- Provider: openrouter
- Model: openai/gpt-5-mini
- Prompt version: extractor.v2
- Prefilter: off
- Dataset: eval/datasets/school_ru.v1.jsonl (n=153)
- Actual cost: $0.1594

| Metric             | Value   |
| ------------------ | ------- |
| n                  | 153     |
| recall             | 96.8%   |
| precision          | 96.8%   |
| typeAccuracy       | 96.8%   |
| categoryAccuracy   | 98.5%   |
| assigneeAccuracy   | 95.5%   |
| dueAccuracy        | 85.7%   |
| cost per 100 cases | $0.1042 |
| avg latency (ms)   | 4404    |

## Failures

- `create-assignment-001` [TP]: due: expected (date=2026-10-02 time=null hint=end_of_week), got 2026-10-01T23:59:00+03:00 (all-day)
- `create-assignment-012` [TP]: due: expected (date=2026-11-27 time=null hint=afternoon), got 2026-11-27T12:00:00+03:00
- `create-event-006` [TP]: assignee: expected none, got ALL; due: expected (date=2026-10-02 time=null hint=none), got 2026-10-02T15:00:00+03:00
- `create-event-007` [TP]: category: expected event, got owner_intent; assignee: expected none, got OWNER
- `create-event-009` [TP]: assignee: expected none, got ALL
- `create-event-013` [TP]: due: expected (date=null time=null hint=soon), got 2026-10-23T18:00:00+03:00
- `create-owner-intent-002` [TP]: due: expected (date=2026-10-31 time=null hint=soon), got 2026-10-16T18:00:00+03:00
- `create-owner-intent-004` [FN]: expected create not shown [category=owner_intent assignee=OWNER due=(date=null time=null hint=none)]
- `create-owner-intent-008` [FN]: expected create not shown [category=owner_intent assignee=OWNER due=(date=null time=null hint=none)]
- `create-owner-intent-010` [FN]: expected create not shown [category=owner_intent assignee=OWNER due=(date=null time=null hint=none)]
- `mod-update-006` [TP]: due: expected (date=2026-11-30 time=null hint=none), got 2026-11-29T23:59:00+03:00 (all-day)
- `neg-discussion-008` [FP]: unexpected create "Отправить статью про билингвальное обучение" (category=commitment) shown
- `neg-question-002` [FP]: unexpected create "Уточнить пароль от Wi‑Fi для гостей" (category=assignment) shown
- `neg-question-007` [FP]: unexpected create "Уточнить место хранения ключей от актового зала" (category=request_to_owner) shown
