# Eval report: google/gemini-3.8-flash / extractor.v1

- Date: 2026-10-01
- Provider: openrouter
- Model: google/gemini-3.8-flash
- Prompt version: extractor.v1
- Prefilter: off
- Dataset: eval/datasets/school_ru.v1.jsonl (n=30)
- Actual cost: $0.0779

| Metric             | Value   |
| ------------------ | ------- |
| n                  | 30      |
| recall             | 84.2%   |
| precision          | 100.0%  |
| typeAccuracy       | 84.2%   |
| categoryAccuracy   | 92.9%   |
| assigneeAccuracy   | 92.9%   |
| dueAccuracy        | 85.7%   |
| cost per 100 cases | $0.2596 |
| avg latency (ms)   | 1958    |

## Failures

- `create-event-007` [TP]: category: expected event, got owner_intent; assignee: expected none; due: mismatch
- `mod-update-003` [FN]: expected update not shown; error: ExtractionError: extraction failed on every model/attempt
- `mod-cancel-001` [FN]: expected cancel not shown; error: ExtractionError: extraction failed on every model/attempt
- `mod-cancel-006` [FN]: expected cancel not shown; error: ExtractionError: extraction failed on every model/attempt
- `neg-discussion-004` [TN]: error: ExtractionError: extraction failed on every model/attempt
- `neg-discussion-010` [TN]: error: ExtractionError: extraction failed on every model/attempt
- `neg-past-005` [TN]: error: ExtractionError: extraction failed on every model/attempt
- `neg-past-010` [TN]: error: ExtractionError: extraction failed on every model/attempt
- `neg-vague-005` [TN]: error: ExtractionError: extraction failed on every model/attempt
- `neg-vague-010` [TN]: error: ExtractionError: extraction failed on every model/attempt
- `neg-question-005` [TN]: error: ExtractionError: extraction failed on every model/attempt
- `neg-question-010` [TN]: error: ExtractionError: extraction failed on every model/attempt
- `neg-joke-005` [TN]: error: ExtractionError: extraction failed on every model/attempt
- `neg-joke-010` [TN]: error: ExtractionError: extraction failed on every model/attempt
- `neg-thanks-005` [TN]: error: ExtractionError: extraction failed on every model/attempt
