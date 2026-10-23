# Changelog

[← Back to repository README / Назад к README библиотеки](README.md)

## 0.1.0 — 2026-10-24

Initial source implementation; npm publication is pending.

- Add a framework-independent fetch SSE client with awaited handler/checkpoint commits, scoped persistence, bounded retries, token refresh and cancellation.
- Add protocol v1 controls for deterministic replay/live boundaries and explicit resynchronization.
- Reuse eventsource-parser 4.1.2 with streaming UTF-8 decoding and byte bounds.
- Add a bounded in-memory Node reference store and HTTP relay. Two listeners can share the same store in one process.
- Add a runnable failure demo, Node tests, headless Chromium scenarios and a clean-consumer package check.
- Document version 0.1.0 in English and Russian, including TypeScript 5.9.3, ES2022 output, runtime requirements and reliability limits.

Source review corrections:

- Preserve received backlog after EOF; reject application frames across an unconfirmed replay/live boundary.
- Release external signal listeners and unread subscription queues on explicit stop/close.
- Apply drain deadlines to heartbeats and destroy undrainable sockets on overflow.
- Avoid allocating stream capacity for rejected subscriptions; reject platform timer overflow.
- Restore matching demo state after reload; use memory checkpoints with memory-only guide state.
- Verify bilingual README/guide examples against packaged declarations and add regression coverage.

No durable distributed store, cross-tab ownership coordination or production application integration is included.

[← Back to repository README / Назад к README библиотеки](README.md)
