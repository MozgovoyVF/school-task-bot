# Eval report: openai/gpt-5-mini / extractor.v1

- Date: 2026-10-01
- Provider: openrouter
- Model: openai/gpt-5-mini
- Prompt version: extractor.v1
- Prefilter: off
- Dataset: eval/datasets/school_ru.v1.jsonl (n=30)
- Actual cost: $0.0350

| Metric             | Value   |
| ------------------ | ------- |
| n                  | 30      |
| recall             | 100.0%  |
| precision          | 90.5%   |
| typeAccuracy       | 100.0%  |
| categoryAccuracy   | 92.9%   |
| assigneeAccuracy   | 92.9%   |
| dueAccuracy        | 85.7%   |
| cost per 100 cases | $0.1166 |
| avg latency (ms)   | 5105    |

## Failures

- `create-assignment-011` [TP]: due: mismatch
- `create-event-007` [TP]: category: expected event, got assignment; assignee: expected none
- `mod-cancel-006` [TP]: unexpected create "Перейти на другой антивирус" shown
- `neg-vague-005` [FP]: unexpected create "Собраться и обсудить стратегию" shown
- `neg-vague-010` [FP]: unexpected create "Сделать новый сайт" shown
