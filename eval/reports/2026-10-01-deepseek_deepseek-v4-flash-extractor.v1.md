# Eval report: deepseek/deepseek-v4-flash / extractor.v1

- Date: 2026-10-01
- Provider: openrouter
- Model: deepseek/deepseek-v4-flash
- Prompt version: extractor.v1
- Prefilter: off
- Dataset: eval/datasets/school_ru.v1.jsonl (n=30)
- Actual cost: $0.0065

| Metric             | Value   |
| ------------------ | ------- |
| n                  | 30      |
| recall             | 94.7%   |
| precision          | 90.0%   |
| typeAccuracy       | 94.7%   |
| categoryAccuracy   | 100.0%  |
| assigneeAccuracy   | 84.6%   |
| dueAccuracy        | 83.3%   |
| cost per 100 cases | $0.0215 |
| avg latency (ms)   | 4943    |

## Failures

- `create-assignment-006` [TP]: assignee: expected P5
- `create-assignment-011` [TP]: due: mismatch
- `create-event-002` [TP]: assignee: expected none
- `create-event-007` [FN]: expected create not shown
- `neg-vague-005` [FP]: unexpected create "Обсудить стратегию" shown
- `neg-vague-010` [FP]: unexpected create "Сделать нормальный сайт" shown
