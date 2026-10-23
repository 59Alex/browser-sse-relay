# browser-sse-relay

<details name="readme-language">
<summary><picture><source media="(prefers-color-scheme: dark)" srcset="assets/lang-en-dark.svg"><img src="assets/lang-en-light.svg" width="42" height="26" alt="EN"></picture></summary>

Version: [0.1.0 guide](docs/v0.1.0/guide.en.md) · [All documentation](docs/index.md)

Recover an SSE stream from the last event your application successfully handled and checkpointed. Includes an independent TypeScript browser client and a Node reference relay with bounded retained history.

**v0.1.0 implementation is available in source. npm publication and a production application integration are not completed.**

## Capabilities

| Capability | Behavior and example |
|---|---|
| Awaited application processing | Handler → checkpoint → committed cursor. A failed checkpoint can repeat an effect. [Example](docs/v0.1.0/guide.en.md#process-and-checkpoint) |
| Replay and relay failover | Resume opaque account/stream-scoped cursors; verify the replay/live boundary. [Example](docs/v0.1.0/guide.en.md#reference-relay-and-handoff) |
| Retry and authentication | Bounded attempts, jitter, retry hints, header/idle timeouts, fresh headers, optional 401 token refresh. [Example](docs/v0.1.0/guide.en.md#retry-and-authentication) |
| Cancellation and logout | Abort transport/timers; prevent future handlers; await in-flight work before clearing the account cursor. [Example](docs/v0.1.0/guide.en.md#stop-and-logout) |
| Explicit resynchronization | Expired history and queue overflow stop with resync; resume from a matching application snapshot and cursor. [Example](docs/v0.1.0/guide.en.md#snapshot-after-resync) |
| Bounded resources | Frame bytes, queue count/bytes, duplicate window, retained history, scopes and subscribers all have limits. [Example](docs/v0.1.0/guide.en.md#limits-and-contracts) |
| Reproducible failure demo | Two real HTTP relay listeners, lost connection, repeated effect after checkpoint failure, retention expiry, snapshot recovery and logout. [Run it](docs/v0.1.0/guide.en.md#run-and-verify) |

The client cannot recover unretained events. Exactly-once effects are not promised. The reference relays share one in-memory object in one process; they do not provide distributed or durable storage.

## Try it locally

Requires Node 22.12 or newer and npm. No credentials are needed for the loopback-only demo.

```sh
npm ci
npm test
npm run demo
```

Visit the URL printed by the demo. It never opens a desktop window automatically. Start, publish, disconnect, then try “Offline + expire history” and “Apply snapshot + resume”.

To verify installation without claiming registry publication:

```sh
npm run test:package
# Produces output/59alex-browser-sse-relay-0.1.0.tgz and tests a clean consumer.
npm install /path/to/59alex-browser-sse-relay-0.1.0.tgz
```

See [the English guide](docs/v0.1.0/guide.en.md), [русское руководство](docs/v0.1.0/guide.ru.md), [protocol](docs/PROTOCOL.md), and [verification record](docs/VERIFICATION.md).

## Language and runtime

Library version **0.1.0** is independent of the compiler version: **TypeScript 5.9.3**, strict declarations, emitted **ES2022 ESM**. Interfaces, readonly contracts and union types are compile-time tools; runtime validation covers scopes, cursors, limits and protocol controls. Runtime APIs include fetch streaming, ReadableStream, TextDecoder, Headers and AbortController. No framework or native EventSource is required. [Version-specific details](docs/v0.1.0/guide.en.md#language-and-runtime).

## License and provenance

[MIT](LICENSE), copyright 2026 Aleksandr Kashevarov. SSE field parsing uses [eventsource-parser](https://github.com/rexxars/eventsource-parser) 4.1.2 under its own MIT license. [Parser decision and alternatives](docs/PARSER-DECISION.md). No private application configuration or infrastructure is included.

</details>

<details name="readme-language" open>
<summary><picture><source media="(prefers-color-scheme: dark)" srcset="assets/lang-ru-dark.svg"><img src="assets/lang-ru-light.svg" width="42" height="26" alt="RU"></picture></summary>

Версия: [руководство 0.1.0](docs/v0.1.0/guide.ru.md) · [Вся документация](docs/index.md)

Восстанавливайте SSE-поток с последнего события, которое приложение успешно обработало и сохранило в checkpoint. В репозитории — независимый TypeScript-клиент для браузера и эталонный Node relay с ограниченной историей событий.

**Реализация v0.1.0 доступна в исходниках. Публикация в npm и интеграция в рабочее приложение пока не завершены.**

## Возможности

| Возможность | Поведение и пример |
|---|---|
| Ожидание обработки приложением | Обработчик → checkpoint → подтверждённый курсор. Ошибка checkpoint может повторить побочный эффект. [Пример](docs/v0.1.0/guide.ru.md#process-and-checkpoint) |
| Replay и смена relay | Восстановление по непрозрачному курсору в области аккаунта и потока; проверка границы replay/live. [Пример](docs/v0.1.0/guide.ru.md#reference-relay-and-handoff) |
| Повторы и авторизация | Ограничение попыток, jitter, retry-подсказки, тайм-ауты заголовков и простоя, свежие headers, обновление токена после 401. [Пример](docs/v0.1.0/guide.ru.md#retry-and-authentication) |
| Отмена и logout | Остановка транспорта и таймеров, запрет новых обработчиков, ожидание текущей операции перед удалением курсора аккаунта. [Пример](docs/v0.1.0/guide.ru.md#stop-and-logout) |
| Явная ресинхронизация | Истёкшая история и переполнение очереди требуют resync; продолжение возможно с согласованным snapshot и курсором. [Пример](docs/v0.1.0/guide.ru.md#snapshot-after-resync) |
| Ограничение ресурсов | Лимиты байтов кадра, размера очередей, окна дублей, истории, числа потоков и подписчиков. [Пример](docs/v0.1.0/guide.ru.md#limits-and-contracts) |
| Воспроизводимое демо отказов | Два HTTP relay, обрыв соединения, повтор эффекта после ошибки checkpoint, истечение истории, snapshot и logout. [Запуск](docs/v0.1.0/guide.ru.md#run-and-verify) |

Клиент не восстанавливает события, которых уже нет на сервере. Exactly-once для побочных эффектов не обещается. Эталонные relay используют один объект в памяти одного процесса; это не распределённое и не долговечное хранилище.

## Локальный запуск

Нужны Node 22.12 или новее и npm. Для демо на loopback-адресе учётные данные не требуются.

```sh
npm ci
npm test
npm run demo
```

Откройте адрес из вывода демо. Программа сама не открывает окна на рабочем столе. Запустите сессию, опубликуйте события, оборвите соединение, затем попробуйте “Offline + expire history” и “Apply snapshot + resume”.

Проверка установки без заявления о публикации в реестре:

```sh
npm run test:package
# Создаёт output/59alex-browser-sse-relay-0.1.0.tgz и проверяет чистый consumer.
npm install /path/to/59alex-browser-sse-relay-0.1.0.tgz
```

См. [русское руководство](docs/v0.1.0/guide.ru.md), [English guide](docs/v0.1.0/guide.en.md), [протокол](docs/PROTOCOL.md) и [результаты проверок](docs/VERIFICATION.md).

## Язык и среда выполнения

Версия библиотеки **0.1.0** не является версией компилятора: используется **TypeScript 5.9.3**, строгая типизация и генерация **ES2022 ESM**. Интерфейсы, readonly-контракты и union-типы действуют при компиляции; во время выполнения проверяются scope, курсоры, лимиты и управляющие кадры. Используются fetch streaming, ReadableStream, TextDecoder, Headers и AbortController. Фреймворк и нативный EventSource не требуются. [Подробности версии](docs/v0.1.0/guide.ru.md#language-and-runtime).

## Лицензия и происхождение

[MIT](LICENSE), copyright 2026 Aleksandr Kashevarov. Для разбора полей SSE используется [eventsource-parser](https://github.com/rexxars/eventsource-parser) 4.1.2 под собственной MIT-лицензией. [Выбор парсера и альтернативы](docs/PARSER-DECISION.md). Приватные конфигурации приложений и инфраструктура в библиотеку не входят.

</details>
