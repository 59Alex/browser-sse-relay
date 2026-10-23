# Parser and transport decision

[← Back to documentation and versions / Назад к документации и версиям](index.md)

The implementation uses eventsource-parser 4.1.2 (MIT) for SSE field parsing. Its source-agnostic feed API fits a client that must await application processing before committing a cursor. Native EventSource commits its transport's last-event ID independently of application handler completion; it cannot provide this library's commit boundary.

Azure fetch-event-source provides useful fetch-based retry and response hooks, but its own message callback and reconnect flow do not own an awaited application-handler plus checkpoint transaction. Reusing its transport would duplicate or bypass that lifecycle. This package instead uses standard fetch, AbortController, ReadableStream readers, and a streaming UTF-8 TextDecoder, while retaining the established SSE parser.

A small byte-oriented frame limiter runs before the parser. It recognizes only CR/LF line boundaries and limits bytes between blank lines; it does not implement SSE field semantics. This prevents an unbounded incomplete line/frame from accumulating inside a parser. Limits apply to comments and unknown fields too. The parser handles data folding, CR/LF/CRLF, comments, id rules, and retry fields. Invalid retry fields and unknown SSE fields retain standard parser behavior; malformed application protocol frames fail closed.

References:
- WHATWG: https://html.spec.whatwg.org/multipage/server-sent-events.html
- Parser source and API: https://github.com/rexxars/eventsource-parser
- Alternative transport: https://github.com/Azure/fetch-event-source

The parser's MIT license remains its own. No application code, credentials, service URLs, or private domain models are imported.

[← Back to documentation and versions / Назад к документации и версиям](index.md)
