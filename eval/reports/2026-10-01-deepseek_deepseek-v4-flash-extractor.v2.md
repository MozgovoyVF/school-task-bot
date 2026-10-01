# Eval report: deepseek/deepseek-v4-flash / extractor.v2

- Date: 2026-10-01
- Provider: openrouter
- Model: deepseek/deepseek-v4-flash
- Prompt version: extractor.v2
- Prefilter: off
- Dataset: eval/datasets/school_ru.v1.jsonl (n=153)
- Actual cost: $0.0104

| Metric | Value |
| --- | --- |
| n | 153 |
| recall | 53.8% |
| precision | 100.0% |
| typeAccuracy | 51.6% |
| categoryAccuracy | 100.0% |
| assigneeAccuracy | 100.0% |
| dueAccuracy | 87.5% |
| cost per 100 cases | $0.0068 |
| avg latency (ms) | 3466 |

## Failures

- `create-assignment-003` [FN]: expected create not shown [category=assignment assignee=P1 due=(date=2026-10-13 time=null hint=morning)]; error: ExtractionError: extraction failed on every model/attempt [deepseek/deepseek-v4-flash: actions.0.target_ref: Invalid string: must match pattern /^[TR]\d+$/ | deepseek/deepseek-v4-flash: actions.0.target_ref: Invalid string: must match pattern /^[TR]\d+$/]
- `create-assignment-007` [FN]: expected create not shown [category=assignment assignee=P9 due=(date=null time=null hint=none)]; error: ExtractionError: extraction failed on every model/attempt [deepseek/deepseek-v4-flash: actions.0.target_ref: Invalid string: must match pattern /^[TR]\d+$/ | deepseek/deepseek-v4-flash: actions.0.target_ref: Invalid string: must match pattern /^[TR]\d+$/]
- `create-assignment-009` [FN]: expected create not shown [category=assignment assignee=P6 due=(date=null time=null hint=none)]; error: ExtractionError: extraction failed on every model/attempt [deepseek/deepseek-v4-flash: actions.0.target_ref: Invalid string: must match pattern /^[TR]\d+$/ | deepseek/deepseek-v4-flash: actions.0.target_ref: Invalid string: must match pattern /^[TR]\d+$/]
- `create-assignment-012` [TP]: due: expected (date=2026-11-27 time=null hint=afternoon), got 2026-11-27T10:00:00+03:00
- `create-event-001` [FN]: expected create not shown [category=event assignee=none due=(date=2026-10-07 time=15:00 hint=none)]; error: ExtractionError: extraction failed on every model/attempt [deepseek/deepseek-v4-flash: actions.0.target_ref: Invalid string: must match pattern /^[TR]\d+$/ | deepseek/deepseek-v4-flash: actions.0.target_ref: Invalid string: must match pattern /^[TR]\d+$/]
- `create-event-002` [FN]: expected create not shown [category=event assignee=none due=(date=2026-10-13 time=null hint=afternoon)]; error: ExtractionError: extraction failed on every model/attempt [deepseek/deepseek-v4-flash: actions.0.target_ref: Invalid string: must match pattern /^[TR]\d+$/ | deepseek/deepseek-v4-flash: actions.0.target_ref: Invalid string: must match pattern /^[TR]\d+$/]
- `create-event-003` [FN]: expected create not shown [category=event assignee=none due=(date=2026-10-22 time=null hint=evening)]; error: ExtractionError: extraction failed on every model/attempt [deepseek/deepseek-v4-flash: actions.0.target_ref: Invalid string: must match pattern /^[TR]\d+$/ | deepseek/deepseek-v4-flash: actions.0.target_ref: Invalid string: must match pattern /^[TR]\d+$/]
- `create-event-004` [FN]: expected create not shown [category=event assignee=none due=(date=2026-11-09 time=null hint=none)]; error: ExtractionError: extraction failed on every model/attempt [deepseek/deepseek-v4-flash: actions.0.target_ref: Invalid string: must match pattern /^[TR]\d+$/ | deepseek/deepseek-v4-flash: actions.0.target_ref: Invalid string: must match pattern /^[TR]\d+$/]
- `create-event-005` [FN]: expected create not shown [category=event assignee=none due=(date=2026-09-26 time=null hint=none)]
- `create-event-006` [FN]: expected create not shown [category=event assignee=none due=(date=2026-10-02 time=null hint=none)]; error: ExtractionError: extraction failed on every model/attempt [deepseek/deepseek-v4-flash: actions.0.target_ref: Invalid string: must match pattern /^[TR]\d+$/ | deepseek/deepseek-v4-flash: actions.0.target_ref: Invalid string: must match pattern /^[TR]\d+$/]
- `create-event-007` [FN]: expected create not shown [category=event assignee=none due=(date=null time=null hint=soon)]; error: ExtractionError: extraction failed on every model/attempt [deepseek/deepseek-v4-flash: actions.0.target_ref: Invalid string: must match pattern /^[TR]\d+$/ | deepseek/deepseek-v4-flash: actions.0.target_ref: Invalid string: must match pattern /^[TR]\d+$/]
- `create-event-008` [FN]: expected create not shown [category=event assignee=none due=(date=2026-10-20 time=11:00 hint=none)]; error: ExtractionError: extraction failed on every model/attempt [deepseek/deepseek-v4-flash: actions.0.target_ref: Invalid string: must match pattern /^[TR]\d+$/ | deepseek/deepseek-v4-flash: actions.0.target_ref: Invalid string: must match pattern /^[TR]\d+$/]
- `create-event-009` [FN]: expected create not shown [category=event assignee=none due=(date=2026-11-21 time=null hint=none)]
- `create-event-010` [FN]: expected create not shown [category=event assignee=none due=(date=2026-12-05 time=null hint=none)]; error: ExtractionError: extraction failed on every model/attempt [deepseek/deepseek-v4-flash: actions.0.target_ref: Invalid string: must match pattern /^[TR]\d+$/ | deepseek/deepseek-v4-flash: actions.0.target_ref: Invalid string: must match pattern /^[TR]\d+$/]
- `create-event-011` [FN]: expected create not shown [category=event assignee=none due=(date=2026-12-20 time=16:00 hint=none)]; error: ExtractionError: extraction failed on every model/attempt [deepseek/deepseek-v4-flash: actions.0.target_ref: Invalid string: must match pattern /^[TR]\d+$/ | deepseek/deepseek-v4-flash: actions.0.target_ref: Invalid string: must match pattern /^[TR]\d+$/]
- `create-event-012` [FN]: expected create not shown [category=event assignee=none due=(date=2026-10-03 time=null hint=none)]
- `create-event-013` [FN]: expected create not shown [category=event assignee=none due=(date=null time=null hint=soon)]
- `create-event-014` [FN]: expected create not shown [category=event assignee=none due=(date=2026-12-18 time=10:00 hint=none)]; error: ExtractionError: extraction failed on every model/attempt [deepseek/deepseek-v4-flash: actions.0.target_ref: Invalid string: must match pattern /^[TR]\d+$/ | deepseek/deepseek-v4-flash: actions.0.target_ref: Invalid string: must match pattern /^[TR]\d+$/]
- `create-owner-intent-001` [FN]: expected create not shown [category=owner_intent assignee=OWNER due=(date=null time=null hint=soon)]; error: ExtractionError: extraction failed on every model/attempt [deepseek/deepseek-v4-flash: actions.0.target_ref: Invalid string: must match pattern /^[TR]\d+$/ | deepseek/deepseek-v4-flash: actions.0.target_ref: Invalid string: must match pattern /^[TR]\d+$/]
- `create-owner-intent-002` [FN]: expected create not shown [category=owner_intent assignee=OWNER due=(date=2026-10-31 time=null hint=soon)]; error: ExtractionError: extraction failed on every model/attempt [deepseek/deepseek-v4-flash: actions.0.target_ref: Invalid string: must match pattern /^[TR]\d+$/ | deepseek/deepseek-v4-flash: actions.0.target_ref: Invalid string: must match pattern /^[TR]\d+$/]
- `create-owner-intent-003` [FN]: expected create not shown [category=owner_intent assignee=OWNER due=(date=2027-01-10 time=null hint=none)]; error: ExtractionError: extraction failed on every model/attempt [deepseek/deepseek-v4-flash: actions.0.target_ref: Invalid string: must match pattern /^[TR]\d+$/ | deepseek/deepseek-v4-flash: actions.0.target_ref: Invalid string: must match pattern /^[TR]\d+$/]
- `create-owner-intent-004` [FN]: expected create not shown [category=owner_intent assignee=OWNER due=(date=null time=null hint=none)]
- `create-owner-intent-006` [FN]: expected create not shown [category=owner_intent assignee=OWNER due=(date=null time=null hint=none)]
- `create-owner-intent-008` [FN]: expected create not shown [category=owner_intent assignee=OWNER due=(date=null time=null hint=none)]
- `create-owner-intent-009` [FN]: expected create not shown [category=owner_intent assignee=OWNER due=(date=2026-12-05 time=null hint=none)]; error: ExtractionError: extraction failed on every model/attempt [deepseek/deepseek-v4-flash: actions.0.target_ref: Invalid string: must match pattern /^[TR]\d+$/ | deepseek/deepseek-v4-flash: actions.0.target_ref: Invalid string: must match pattern /^[TR]\d+$/]
- `create-owner-intent-010` [FN]: expected create not shown [category=owner_intent assignee=OWNER due=(date=null time=null hint=none)]
- `create-owner-intent-011` [FN]: expected create not shown [category=owner_intent assignee=OWNER due=(date=null time=null hint=none)]
- `create-owner-intent-012` [TP]: due: expected (date=2026-12-24 time=null hint=soon), got 2026-12-18T18:00:00+03:00
- `create-owner-intent-013` [FN]: expected create not shown [category=owner_intent assignee=OWNER due=(date=null time=null hint=none)]
- `create-owner-intent-014` [FN]: expected create not shown [category=owner_intent assignee=OWNER due=(date=null time=null hint=none)]
- `create-commitment-003` [FN]: expected create not shown [category=commitment assignee=P4 due=(date=2026-10-23 time=null hint=end_of_week)]; error: ExtractionError: extraction failed on every model/attempt [deepseek/deepseek-v4-flash: actions.0.target_ref: Invalid string: must match pattern /^[TR]\d+$/ | deepseek/deepseek-v4-flash: actions.0.target_ref: Invalid string: must match pattern /^[TR]\d+$/]
- `create-commitment-004` [FN]: expected create not shown [category=commitment assignee=P9 due=(date=null time=null hint=none)]; error: ExtractionError: extraction failed on every model/attempt [deepseek/deepseek-v4-flash: actions.0.target_ref: Invalid string: must match pattern /^[TR]\d+$/ | deepseek/deepseek-v4-flash: actions.0.target_ref: Invalid string: must match pattern /^[TR]\d+$/]
- `create-commitment-005` [FN]: expected create not shown [category=commitment assignee=P2 due=(date=2026-11-05 time=null hint=none)]; error: ExtractionError: extraction failed on every model/attempt [deepseek/deepseek-v4-flash: actions.0.target_ref: Invalid string: must match pattern /^[TR]\d+$/ | deepseek/deepseek-v4-flash: actions.0.target_ref: Invalid string: must match pattern /^[TR]\d+$/]
- `create-commitment-006` [FN]: expected create not shown [category=commitment assignee=P8 due=(date=null time=null hint=none)]; error: ExtractionError: extraction failed on every model/attempt [deepseek/deepseek-v4-flash: actions.0.target_ref: Invalid string: must match pattern /^[TR]\d+$/ | deepseek/deepseek-v4-flash: actions.0.target_ref: Invalid string: must match pattern /^[TR]\d+$/]
- `create-commitment-007` [FN]: expected create not shown [category=commitment assignee=P5 due=(date=2026-11-18 time=null hint=none)]; error: ExtractionError: extraction failed on every model/attempt [deepseek/deepseek-v4-flash: actions.0.target_ref: Invalid string: must match pattern /^[TR]\d+$/ | deepseek/deepseek-v4-flash: actions.0.target_ref: Invalid string: must match pattern /^[TR]\d+$/]
- `create-commitment-008` [FN]: expected create not shown [category=commitment assignee=P3 due=(date=null time=null hint=none)]; error: ExtractionError: extraction failed on every model/attempt [deepseek/deepseek-v4-flash: actions.0.target_ref: Invalid string: must match pattern /^[TR]\d+$/ | deepseek/deepseek-v4-flash: actions.0.target_ref: Invalid string: must match pattern /^[TR]\d+$/]
- `create-commitment-010` [FN]: expected create not shown [category=commitment assignee=P6 due=(date=null time=null hint=none)]; error: ExtractionError: extraction failed on every model/attempt [deepseek/deepseek-v4-flash: actions.0.target_ref: Invalid string: must match pattern /^[TR]\d+$/ | deepseek/deepseek-v4-flash: actions.0.target_ref: Invalid string: must match pattern /^[TR]\d+$/]
- `create-commitment-011` [FN]: expected create not shown [category=commitment assignee=P9 due=(date=2026-12-14 time=null hint=none)]; error: ExtractionError: extraction failed on every model/attempt [deepseek/deepseek-v4-flash: actions.0.target_ref: Invalid string: must match pattern /^[TR]\d+$/ | deepseek/deepseek-v4-flash: actions.0.target_ref: Invalid string: must match pattern /^[TR]\d+$/]
- `create-commitment-012` [FN]: expected create not shown [category=commitment assignee=P4 due=(date=null time=null hint=none)]; error: ExtractionError: extraction failed on every model/attempt [deepseek/deepseek-v4-flash: actions.0.target_ref: Invalid string: must match pattern /^[TR]\d+$/ | deepseek/deepseek-v4-flash: actions.0.target_ref: Invalid string: must match pattern /^[TR]\d+$/]
- `create-request-001` [FN]: expected create not shown [category=request_to_owner assignee=OWNER due=(date=null time=null hint=none)]; error: ExtractionError: extraction failed on every model/attempt [deepseek/deepseek-v4-flash: actions.0.target_ref: Invalid string: must match pattern /^[TR]\d+$/ | deepseek/deepseek-v4-flash: actions.0.target_ref: Invalid string: must match pattern /^[TR]\d+$/]
- `create-request-003` [FN]: expected create not shown [category=request_to_owner assignee=OWNER due=(date=null time=null hint=none)]
- `create-request-004` [FN]: expected create not shown [category=request_to_owner assignee=OWNER due=(date=2026-10-31 time=null hint=none)]
- `create-request-006` [FN]: expected create not shown [category=request_to_owner assignee=OWNER due=(date=null time=null hint=none)]; error: ExtractionError: extraction failed on every model/attempt [deepseek/deepseek-v4-flash: actions.0.target_ref: Invalid string: must match pattern /^[TR]\d+$/ | deepseek/deepseek-v4-flash: actions.0.target_ref: Invalid string: must match pattern /^[TR]\d+$/]
- `create-request-007` [FN]: expected create not shown [category=request_to_owner assignee=OWNER due=(date=null time=null hint=none)]
- `create-request-014` [FN]: expected create not shown [category=request_to_owner assignee=OWNER due=(date=null time=null hint=none)]
- `mod-update-002` [TP]: expected update not shown [due=(date=2026-11-04 time=null hint=none)]; unexpected cancel shown
- `mod-update-004` [TP]: expected update not shown [due=(date=null time=null hint=soon)]; unexpected cancel shown
