# Verification record — 0.1.0

[← Back to documentation and versions / Назад к документации и версиям](index.md)

[Documentation index](index.md) · [English guide](v0.1.0/guide.en.md) · [Русское руководство](v0.1.0/guide.ru.md)

Local verification on 2026-10-24 used Linux, Node 24.21.0, npm 11.19.0, TypeScript 5.9.3 and Playwright 1.64.1. Java versions do not apply to this TypeScript package.

| Check | Actual result |
|---|---|
| `npm test` | 30 passing Node tests; no failures or skipped tests. |
| `npm run test:browser` | Headless Chromium 156.0.8078.4; six scenarios passed; no uncaught page exceptions. |
| `npm run test:package` | Tarball installed in a fresh temporary consumer; browser/server exports, declarations and EN/RU guide snippets checked; actual HTTP event handled and checkpointed. |

Node tests cover fragmented UTF-8, BOM, CR/LF/CRLF, multiline data, comments, retry fields, truncated frames, exact byte limits, Unicode metadata accounting, handler/checkpoint failures, logout with pending work, token refresh, retry cancellation, timeouts, malformed controls, deduplication bounds, scope isolation, concurrent publication, atomic replay/live ordering, retention boundaries, slow consumers and real HTTP reconnect.

The browser scenarios verify:

1. Authenticated cross-origin connection and first durable checkpoint.
2. Abrupt connection loss followed by replay through relay B without a gap.
3. Handler effect repeated after a deliberately failed checkpoint.
4. Offline retention expiry producing terminal resync.
5. Applying a consistent counter snapshot and resuming subsequent events.
6. Logout clearing the scoped checkpoint and preventing further delivery.

The two relay listeners share the same MemoryEventStore object. This checks transport handoff in one process; it is not evidence for a durable distributed store.

## Reproduce

```bash
npm ci
npm test
npx playwright install chromium
npm run test:browser
npm run test:package
```

Browser evidence is generated under `output/playwright/`; package evidence under `output/package-smoke.json`. These machine-local outputs are ignored by Git. The demo is executable independently with `npm run demo` and does not open a desktop window.

## Declared targets and remaining gates

ES2022 ESM output requires streaming fetch, ReadableStream, TextDecoder, Headers and AbortController. The reference server and development tools require Node 22.12+. CI is configured for Node 22.12.0 and 24, but no remote CI result is claimed by this local record. Firefox, WebKit, other browser versions and the Node 22 runtime have not been tested locally.

Registry authentication, ownership of the npm name, actual npm publication and production application integration remain open. A production durable history adapter, cross-tab single-writer coordination and a broader browser matrix are separate work. See [ROADMAP](../ROADMAP.md).

[← Back to documentation and versions / Назад к документации и версиям](index.md)
