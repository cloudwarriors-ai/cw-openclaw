# PK-7a: do not deploy without PK-7b

PK-7a (backend profile, guard, capability registry) must ship together with PK-7b, never alone:

- its audit rows go to the v1 `audit.jsonl`, which breaks the v1-freeze/epoch continuity;
- the allowed health GET writes no HTTP audit row and sends no correlation header or parameter;
- an audit-write failure only reaches `console.error` (INV-5, INV-6 and INV-15 are PK-7b's).
