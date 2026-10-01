# Eval report: anthropic/claude-haiku-4.5 / extractor.v1

- Date: 2026-10-01
- Provider: openrouter
- Model: anthropic/claude-haiku-4.5
- Prompt version: extractor.v1
- Prefilter: off
- Dataset: eval/datasets/school_ru.v1.jsonl (n=30)
- Actual cost: $0.1542

| Metric             | Value   |
| ------------------ | ------- |
| n                  | 30      |
| recall             | 100.0%  |
| precision          | 95.0%   |
| typeAccuracy       | 100.0%  |
| categoryAccuracy   | 100.0%  |
| assigneeAccuracy   | 100.0%  |
| dueAccuracy        | 71.4%   |
| cost per 100 cases | $0.5140 |
| avg latency (ms)   | 3104    |

## Failures

- `create-assignment-011` [TP]: due: mismatch
- `create-event-007` [TP]: due: mismatch
- `neg-vague-005` [FP]: unexpected create "Собраться и обсудить стратегию" shown
- `neg-vague-010` [TN]: error: ExtractionError: extraction failed on every model/attempt
- `neg-question-005` [TN]: error: ExtractionError: extraction failed on every model/attempt
- `neg-question-010` [TN]: error: ExtractionError: extraction failed on every model/attempt
- `neg-joke-005` [TN]: error: ExtractionError: extraction failed on every model/attempt
- `neg-joke-010` [TN]: error: ExtractionError: extraction failed on every model/attempt
- `neg-thanks-005` [TN]: error: ExtractionError: extraction failed on every model/attempt
