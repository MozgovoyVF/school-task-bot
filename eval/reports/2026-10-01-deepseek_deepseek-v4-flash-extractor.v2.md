# Eval report: deepseek/deepseek-v4-flash / extractor.v2

- Date: 2026-10-01
- Provider: openrouter
- Model: deepseek/deepseek-v4-flash
- Prompt version: extractor.v2
- Prefilter: off
- Dataset: eval/datasets/school_ru.v1.jsonl (n=153)
- Actual cost: $0.0086

| Metric             | Value   |
| ------------------ | ------- |
| n                  | 153     |
| recall             | 49.5%   |
| precision          | 100.0%  |
| typeAccuracy       | 48.4%   |
| categoryAccuracy   | 95.7%   |
| assigneeAccuracy   | 95.7%   |
| dueAccuracy        | 100.0%  |
| cost per 100 cases | $0.0056 |
| avg latency (ms)   | 4219    |

## Failures

- `create-assignment-007` [FN]: expected create not shown [category=assignment assignee=P9 due=(date=null time=null hint=none)]
- `create-assignment-012` [FN]: expected create not shown [category=assignment assignee=P4 due=(date=2026-11-27 time=null hint=afternoon)]
- `create-event-001` [FN]: expected create not shown [category=event assignee=none due=(date=2026-10-07 time=15:00 hint=none)]
- `create-event-002` [FN]: expected create not shown [category=event assignee=none due=(date=2026-10-13 time=null hint=afternoon)]
- `create-event-003` [FN]: expected create not shown [category=event assignee=none due=(date=2026-10-22 time=null hint=evening)]
- `create-event-004` [FN]: expected create not shown [category=event assignee=none due=(date=2026-11-09 time=null hint=none)]
- `create-event-005` [FN]: expected create not shown [category=event assignee=none due=(date=2026-09-26 time=null hint=none)]
- `create-event-006` [FN]: expected create not shown [category=event assignee=none due=(date=2026-10-02 time=null hint=none)]
- `create-event-007` [FN]: expected create not shown [category=event assignee=none due=(date=null time=null hint=soon)]
- `create-event-008` [FN]: expected create not shown [category=event assignee=none due=(date=2026-10-20 time=11:00 hint=none)]
- `create-event-009` [FN]: expected create not shown [category=event assignee=none due=(date=2026-11-21 time=null hint=none)]
- `create-event-010` [TP]: category: expected event, got commitment; assignee: expected none, got P6
- `create-event-011` [FN]: expected create not shown [category=event assignee=none due=(date=2026-12-20 time=16:00 hint=none)]
- `create-event-012` [FN]: expected create not shown [category=event assignee=none due=(date=2026-10-03 time=null hint=none)]
- `create-event-013` [FN]: expected create not shown [category=event assignee=none due=(date=null time=null hint=soon)]
- `create-event-014` [FN]: expected create not shown [category=event assignee=none due=(date=2026-12-18 time=10:00 hint=none)]
- `create-owner-intent-002` [FN]: expected create not shown [category=owner_intent assignee=OWNER due=(date=2026-10-31 time=null hint=soon)]
- `create-owner-intent-003` [FN]: expected create not shown [category=owner_intent assignee=OWNER due=(date=2027-01-10 time=null hint=none)]
- `create-owner-intent-004` [FN]: expected create not shown [category=owner_intent assignee=OWNER due=(date=null time=null hint=none)]
- `create-owner-intent-005` [FN]: expected create not shown [category=owner_intent assignee=OWNER due=(date=null time=null hint=none)]
- `create-owner-intent-006` [FN]: expected create not shown [category=owner_intent assignee=OWNER due=(date=null time=null hint=none)]
- `create-owner-intent-007` [FN]: expected create not shown [category=owner_intent assignee=OWNER due=(date=2026-11-20 time=null hint=end_of_week)]
- `create-owner-intent-008` [FN]: expected create not shown [category=owner_intent assignee=OWNER due=(date=null time=null hint=none)]
- `create-owner-intent-010` [FN]: expected create not shown [category=owner_intent assignee=OWNER due=(date=null time=null hint=none)]
- `create-owner-intent-011` [FN]: expected create not shown [category=owner_intent assignee=OWNER due=(date=null time=null hint=none)]
- `create-owner-intent-012` [FN]: expected create not shown [category=owner_intent assignee=OWNER due=(date=2026-12-24 time=null hint=soon)]
- `create-owner-intent-013` [FN]: expected create not shown [category=owner_intent assignee=OWNER due=(date=null time=null hint=none)]
- `create-owner-intent-014` [FN]: expected create not shown [category=owner_intent assignee=OWNER due=(date=null time=null hint=none)]
- `create-commitment-003` [FN]: expected create not shown [category=commitment assignee=P4 due=(date=2026-10-23 time=null hint=end_of_week)]
- `create-commitment-004` [FN]: expected create not shown [category=commitment assignee=P9 due=(date=null time=null hint=none)]
- `create-commitment-005` [FN]: expected create not shown [category=commitment assignee=P2 due=(date=2026-11-05 time=null hint=none)]
- `create-commitment-006` [FN]: expected create not shown [category=commitment assignee=P8 due=(date=null time=null hint=none)]
- `create-commitment-008` [FN]: expected create not shown [category=commitment assignee=P3 due=(date=null time=null hint=none)]
- `create-commitment-009` [FN]: expected create not shown [category=commitment assignee=P1 due=(date=null time=null hint=none)]
- `create-commitment-010` [FN]: expected create not shown [category=commitment assignee=P6 due=(date=null time=null hint=none)]
- `create-commitment-011` [FN]: expected create not shown [category=commitment assignee=P9 due=(date=2026-12-14 time=null hint=none)]
- `create-commitment-013` [FN]: expected create not shown [category=commitment assignee=P2 due=(date=null time=null hint=none)]
- `create-commitment-014` [FN]: expected create not shown [category=commitment assignee=P10 due=(date=null time=null hint=none)]
- `create-request-001` [FN]: expected create not shown [category=request_to_owner assignee=OWNER due=(date=null time=null hint=none)]
- `create-request-003` [FN]: expected create not shown [category=request_to_owner assignee=OWNER due=(date=null time=null hint=none)]
- `create-request-004` [FN]: expected create not shown [category=request_to_owner assignee=OWNER due=(date=2026-10-31 time=null hint=none)]
- `create-request-005` [FN]: expected create not shown [category=request_to_owner assignee=OWNER due=(date=null time=null hint=none)]
- `create-request-006` [FN]: expected create not shown [category=request_to_owner assignee=OWNER due=(date=null time=null hint=none)]
- `create-request-007` [FN]: expected create not shown [category=request_to_owner assignee=OWNER due=(date=null time=null hint=none)]
- `create-request-010` [FN]: expected create not shown [category=request_to_owner assignee=OWNER due=(date=null time=null hint=none)]
- `create-request-012` [FN]: expected create not shown [category=request_to_owner assignee=OWNER due=(date=null time=null hint=none)]
- `create-request-013` [FN]: expected create not shown [category=request_to_owner assignee=OWNER due=(date=null time=null hint=none)]
- `create-request-014` [FN]: expected create not shown [category=request_to_owner assignee=OWNER due=(date=null time=null hint=none)]
- `mod-update-004` [TP]: expected update not shown [due=(date=null time=null hint=soon)]; unexpected cancel shown
