# browser-sse-relay 0.1.0 — руководство

[English](guide.en.md) · [Русский](guide.ru.md) · [Выбор версии](../README.md) · [README репозитория](../../README.ru.md)

## Назначение

Библиотека нужна, когда после обрыва следует продолжить с последнего обработанного приложением события, а не с последнего полученного транспортом кадра. Сервер должен соблюдать [протокол v1](../PROTOCOL.md), хранить историю и предоставлять согласованный snapshot, если обычное восстановление уже невозможно.

| Задача | API |
|---|---|
| Сначала обработать, затем сохранить курсор | SseRelayClient.onEvent и CheckpointStore |
| Повторить запрос со свежей авторизацией | headers, refreshAuth, настройки retry |
| Разделить аккаунты и потоки | StreamScope и scoped-ключи checkpoint |
| Остановить сессию и очистить состояние аккаунта | stop(), терминальный результат start(), logout() |
| Восстановиться через другой reference relay | MemoryEventStore и createNodeRelay |
| Продолжить после истечения истории | Результат resync и initialCursor из snapshot |
| Ограничить память и ожидание | Лимиты кадров, очередей, дублей, истории и тайм-ауты |

<a id="language-and-runtime"></a>
## Язык и среда выполнения

Версия 0.1.0 использует TypeScript 5.9.3 со strict mode, exact optional properties и проверкой индексного доступа. Интерфейсы, readonly-контракты событий и scope, а также union-типы состояний выявляют ошибки при компиляции, но не создают авторизацию во время выполнения. Результат сборки — ES2022 ESM и декларации типов, без CommonJS-бандла.

Во время выполнения используются стандартные механизмы: async/await, optional chaining, nullish coalescing, Map/Set, потоковый fetch, ReadableStream reader, TextDecoder, Headers и AbortController/AbortSignal. Нет декораторов TypeScript, preview API и привязки к lifecycle фреймворка. Поля private в TypeScript — ограничение компилятора, а не граница безопасности.

Для эталонного Node-сервера и инструментов разработки нужен Node 22.12+. Локальные проверки выполнены на Node 24.21.0 и headless Chromium 156.0.8078.4. Firefox, WebKit и старые браузеры не проверены. Потребителю в браузере нужны перечисленные API и сборщик с поддержкой ESM либо import map. В демо import map уже настроен.

## Установка проверенного локального пакета

```sh
npm ci
npm test
npm run test:package
npm install /path/to/output/59alex-browser-sse-relay-0.1.0.tgz
```

Проверка пакета создаёт чистый consumer, проверяет оба export path и декларации TypeScript, затем обрабатывает событие через настоящий HTTP SSE. Это не публикация в npm. Перед выпуском ещё нужно подтвердить доступ к npm и владение именем пакета.

<a id="process-and-checkpoint"></a>
## Обработка и checkpoint

Браузерный пример для потока счётчика. Endpoint должен отправлять управляющие кадры протокола v1 и JSON-события с числовым полем value. Scope должен соответствовать авторизованному аккаунту, а не произвольному идентификатору из пользовательского ввода.

```ts
import { SseRelayClient, LocalStorageCheckpointStore } from '@59alex/browser-sse-relay';

const scope = { accountId: 'account-42', streamId: 'counter' };
const checkpoint = new LocalStorageCheckpointStore(localStorage);
let counter = 0;

const options = {
  scope,
  url: '/api/events?stream=counter',
  checkpoint,
  async onEvent(event, context) {
    context.signal.throwIfAborted();
    const payload = JSON.parse(event.data);
    if (typeof payload.value !== 'number' || !Number.isFinite(payload.value)) {
      throw new Error('Invalid counter payload');
    }
    counter = payload.value; // Repeating this assignment is idempotent.
  },
} satisfies import('@59alex/browser-sse-relay').RelayOptions;

let client = new SseRelayClient(options);
const finished = client.start();
```

Наблюдаемая последовательность: завершение обработчика → завершение checkpoint.save → изменение committedCursor. Пока оба этапа не закончились, reconnect использует предыдущий курсор. Если присваивание успешно, а сохранение checkpoint завершилось ошибкой, то же событие может обработаться ещё раз. Для своих эффектов используйте идемпотентность или транзакционную дедупликацию; checkpoint браузера не может атомарно подтвердить отдельный побочный эффект в backend.

Окно дедупликации содержит только успешно подтверждённые ID текущей сессии и имеет ограниченный размер. Оно не долговечное. Новая сессия после сбоя может повторить эффект. Ошибки хранилища расходуют ограниченный бюджет повторов, а не игнорируются.

Без адаптера курсор живёт только в экземпляре клиента. Для общего курсора в памяти процесса используйте MemoryCheckpointStore. Свой адаптер реализует load(scope, signal), save(scope, cursor, signal) и clear(scope, signal). Проверяйте отмену непосредственно перед сохранением и завершайте все Promise. Не разрешайте двум сессиям одновременно записывать checkpoint одного scope; перед повторным использованием дождитесь logout. Координация владельцев между вкладками не входит в библиотеку.

<a id="retry-and-authentication"></a>
## Повторы и авторизация

Следующие настройки передаются при создании клиента из предыдущего примера. Endpoint обновления токена и формат его JSON — контракт приложения; библиотека не реализует identity provider.

```ts
let token = 'initial-application-token';
const authentication = {
  headers: () => ({ Authorization: `Bearer ${token}` }),
  async refreshAuth({ signal }) {
    const response = await fetch('/api/token/refresh', { method: 'POST', signal });
    if (!response.ok) return false;
    const body = await response.json();
    if (typeof body.token !== 'string') return false;
    token = body.token;
    return true;
  },
  retry: { maxAttempts: 8, minDelayMs: 250, maxDelayMs: 10000, jitter: 0.2 },
  connectTimeoutMs: 10000,
  idleTimeoutMs: 45000,
} satisfies Partial<import('@59alex/browser-sse-relay').RelayOptions>;

client = new SseRelayClient({ ...options, ...authentication });
```

Используйте эту конфигурацию вместо создания предыдущего клиента: два владельца одного checkpoint одновременно запускать нельзя. Headers формируются заново перед каждым запросом. HTTP 401 вызывает refreshAuth, если он задан; false или исключение завершают авторизацию. HTTP 403 терминален. Повторные 401 всё равно расходуют конечный бюджет. maxAttempts — число всех соединений одной сессии вместе с первым; после периода успешной работы счётчик не сбрасывается.

Сетевые ошибки, тайм-ауты заголовков/простоя, HTTP 408/429 и 5xx вызывают повтор с ограниченной задержкой и jitter. Подсказки SSE retry и HTTP Retry-After ограничиваются настроенным диапазоном. Другие HTTP-ошибки и некорректные управляющие кадры завершают сессию. HTTP 204 закрывает её штатно, 409/410 требуют resync. Редиректы запрещены. Для cross-origin запросов сервер должен разрешить конкретный origin и заголовки запроса, а также открыть клиенту X-Relay-Protocol; демо показывает эту настройку host-приложения.

На здоровом, но тихом потоке сервер должен присылать комментарии/heartbeat чаще idleTimeoutMs. Таймеры ограничивают ожидание сети; обработчики приложения, обновление токена и checkpoint-адаптеры сами отвечают за завершение своих асинхронных операций.

<a id="stop-and-logout"></a>
## Остановка и logout

Продолжение первого примера с активным клиентом:

```ts
client.stop();
const stopped = await client.start(); // Returns the same session promise.
console.log(stopped.state, stopped.reason, stopped.cursor);

await client.logout(); // Await in-flight work, then clear this scope's checkpoint.
```

stop() прерывает транспорт и отложенные повторы, запрещая запуск следующего обработчика. Уже выполненный эффект текущего обработчика отменить невозможно. Такой обработчик получает отменённый signal и может проверить context.isCurrent() перед применением своего отложенного эффекта.

logout() ждёт завершения сессии, затем удаляет её scoped-курсор. Обработчик или адаптер, не завершающий свою операцию, может задержать это ожидание. Завершённый экземпляр не запускается заново: создайте новый SseRelayClient. Memory/localStorage-адаптеры используют оба поля accountId и streamId, поэтому logout одного аккаунта не стирает курсор другого.

<a id="snapshot-after-resync"></a>
## Snapshot после resync

Resync — терминальный результат, а не указание удалить курсор и начать с самого свежего события. Приложение обязано установить состояние и соответствующую позицию лога. Продолжение использует options и counter из первого примера, а также endpoint приложения, атомарно возвращающий { value, cursor, scope }.

```ts
const result = await finished;
if (result.state === 'resync') {
  const response = await fetch('/api/snapshot');
  if (!response.ok) throw new Error('Snapshot unavailable');
  const snapshot = await response.json();
  if (snapshot.scope.accountId !== scope.accountId || snapshot.scope.streamId !== scope.streamId) {
    throw new Error('Snapshot scope mismatch');
  }
  if (typeof snapshot.value !== 'number' || !Number.isFinite(snapshot.value)) {
    throw new Error('Invalid snapshot');
  }
  counter = snapshot.value; // Apply application state BEFORE committing its cursor.
  client = new SseRelayClient({ ...options, initialCursor: snapshot.cursor });
  void client.start();
}
```

initialCursor проверяется, сохраняется и заменяет устаревший checkpoint. События между снятием snapshot и новой подпиской будут воспроизведены, если история ещё покрывает позицию. Если за время получения snapshot нужная история тоже успела истечь, потребуется новый resync; библиотека не придумывает другой курсор.

Демо получает согласованный snapshot счётчика, читая состояние и MemoryEventStore.currentCursor в одном синхронном участке JavaScript. Рабочее приложение с базой данных и логом должно обеспечить эквивалентную согласованность. Асинхронно прочитать базу, а затем отдельно запросить последний курсор лога — способ потерять события.

<a id="reference-relay-and-handoff"></a>
## Эталонный relay и граница replay/live

Node-пример запускает два listener, разделяющих один объект. Фиксированный bearer здесь нужен только для демонстрации; замените authenticate и authorize настоящей проверкой доступа host-приложения.

```ts
import { createServer } from 'node:http';
import { MemoryEventStore, createNodeRelay } from '@59alex/browser-sse-relay/server';

const store = new MemoryEventStore({ maxEventsPerStream: 256, retentionMs: 300000 });
const scope = { accountId: 'demo-account', streamId: 'counter' };
for (const port of [8081, 8082]) {
  const relay = createNodeRelay({
    store,
    authenticate: request => request.headers.authorization === 'Bearer demo-only'
      ? scope.accountId : undefined,
    stream: () => scope.streamId,
  });
  createServer((request, response) => { void relay(request, response); }).listen(port, '127.0.0.1');
}
store.append(scope, JSON.stringify({ value: 1 }), 'counter');
```

subscribe синхронно проверяет позицию, фиксирует watermark, регистрирует подписчика и помещает hello/replay/ready в очередь, не отдавая управление event loop. Новые события идут после ready. Это детерминированная граница в одном процессе JavaScript. Тесты публикуют события, пока replay ещё не прочитан, и проверяют точный порядок результата.

Запрос без курсора означает чтение с начала лога. Если начало истекло, сервер требует resync, а не скрывает пропуск. Курсор непосредственно перед границей вытеснения остаётся пригодным, пока все следующие события доступны. Курсоры — непрозрачные строки printable ASCII, уникальные внутри потока; клиент не должен разбирать их или сравнивать порядок.

Два listener с общим MemoryEventStore не являются распределённым хранилищем. Перезапуск процесса уничтожает историю. Межпроцессный адаптер должен отдельно гарантировать порядок лога, атомарную подписку replay/live и долговечность; такого production-адаптера в 0.1.0 нет.

<a id="limits-and-contracts"></a>
## Лимиты и контракты

```ts
const limitedClient = new SseRelayClient({
  ...options,
  limits: {
    maxFrameBytes: 65536,
    maxQueuedEvents: 128,
    maxQueuedBytes: 1048576,
    dedupEntries: 1024,
  },
});
```

Это стандартные клиентские лимиты. Размер кадра измеряется в wire bytes; размер очереди — в UTF-8 байтах data, id и типа события. Помимо очереди в памяти могут находиться один кадр текущего обработчика и ограниченный кадр парсера. Буферы браузера/ОС и копии приложения в этот расчёт не входят. Переполнение очереди и слишком большой кадр требуют resync, а не молчаливого пропуска события.

Серверные значения по умолчанию: 256 событий на поток, 300 секунд хранения, 16 MiB общей истории, 64 scope, 64 подписчика, 1024 кадра и 1 MiB очереди на подписчика, 64 KiB на прикладной кадр. Переполнение подписчика и слишком большой replay требуют resync. Сокет, который не освобождает буфер записи, закрывается через пять секунд. Если сеть уже оборвалась, доставка управляющего кадра resync не гарантируется; следующий reconnect снова проверит наличие истории.

Проверка scope не заменяет авторизацию. HTTP host определяет аккаунт и допустимые потоки, отвечает за TLS, разрешённые origins, квоты и согласованные snapshot. Транспортное подтверждение не доказывает долговечность эффекта приложения.

| Альтернатива | Когда подходит |
|---|---|
| Нативный EventSource | Стандартный SSE-транспорт браузера без владения checkpoint на уровне приложения. |
| fetch-event-source | Fetch-based SSE с настройкой ответа, заголовков и повторов; восстановление приложения и хранение позиции остаются вашей задачей. |
| browser-sse-relay | Протокол retained history, курсор после awaited handler/checkpoint, явный resync и исполняемая эталонная модель отказов. |

См. [выбор парсера](../PARSER-DECISION.md). Это не drop-in клиент произвольного SSE-endpoint без управляющих кадров протокола v1.

<a id="run-and-verify"></a>
## Запуск и проверка

```sh
npm ci
npm test
npm run demo
# Open the printed loopback URL yourself.

npx playwright install chromium
npm run test:browser
npm run test:package
```

Браузерная проверка запускается headless. Она проверяет первый checkpoint, replay через relay B после обрыва, повтор эффекта при ошибке checkpoint, терминальный resync после истечения истории, восстановление snapshot и logout без старых callback/reconnect. Версия браузера и снимок записываются в output/playwright. Проверка пакета устанавливает tarball в новый временный consumer, проверяет публичные типы и обрабатывает HTTP-событие.

Если браузер не запускается, обычно отсутствует его бинарник Playwright: выполните команду установки выше. 401 означает отказ host-аутентификации. protocol-error часто указывает на отсутствие заголовка/управляющего кадра, чужой scope, неверный формат или watermark replay. cursor-unavailable требует согласованного snapshot, а не цикла запросов без курсора. retry-exhausted требует решения приложения: клиент не переподключается бесконечно.

Оставшиеся условия выпуска: авторизация npm и владение именем, публикация в реестре, интеграция в рабочее приложение и дополнительные браузеры. [Проверки](../VERIFICATION.md) и [план](../../ROADMAP.md) отделяют проверенные исходники от опубликованных артефактов.
