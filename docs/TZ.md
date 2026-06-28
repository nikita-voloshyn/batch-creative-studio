# Техническое задание — Batch Creative Studio

> Веб-приложение для пакетной генерации стилизованных social-постов из product-изображений с условием по reference-стилю. Стек: **Next.js (App Router) + Vercel**.

---

## 1. Контекст и цель

**Проблема.** Бренду/маркетологу нужно из набора product-фото быстро получить пачку готовых social-постов в едином визуальном стиле, заданном 1–2 reference-картинками (setting / style / mood). Делать это вручную в редакторе — долго и неконсистентно.

**Цель продукта.** Пользователь загружает N product-изображений + 1–2 reference, запускает batch — и получает N стилизованных постов. Результаты появляются **по мере готовности** (progressive rendering), а не все разом в конце. Система устойчива на масштабе: retries, multi-provider failover, стабильный визуальный стиль между постами.

**Целевая аудитория ТЗ.** Инженер, реализующий приложение, и ревьюер, оценивающий судейство (что построено / что осознанно опущено).

### 1.1. Ключевые принципы (приоритеты оценки)

1. **Judgment > полнота.** Каждый компонент существует ради core-сценария; то, что не критично за отведённое время, явно вынесено в §15 (Out of scope) с обоснованием.
2. **Reliability — first-class, не afterthought.** Retries, failover, partial-failure — часть архитектуры, а не «прикрутим потом».
3. **Style consistency как продуктовая фича.** Согласованность стиля между N постами — измеримое требование, а не побочный эффект.
4. **Progressive UX.** Пользователь видит прогресс и первые результаты за секунды, не ждёт весь batch.

---

## 2. Пользовательский сценарий (core flow)

```
1. Пользователь открывает приложение.
2. Загружает N product-изображений (drag&drop / file picker).      [N: 1..20]
3. Загружает 1–2 reference-изображения (style/mood).
4. (Опц.) вводит текстовый brief / caption-hint / выбирает формат (1:1, 4:5, 9:16).
5. Жмёт "Generate".
6. Появляется сетка из N плейсхолдеров (по числу product-картинок).
7. Каждая плитка независимо проходит: queued → generating → done | failed.
8. Готовые посты рендерятся в плитках сразу по готовности (progressive).
9. Failed-плитки показывают причину + кнопку "Retry" (точечный ретрай).
10. Пользователь скачивает отдельные посты или весь batch (zip).
11. (Full product) batch сохраняется в историю, доступен по постоянной ссылке.
```

**Definition of Done сценария:** при загрузке 10 product + 1 reference пользователь видит первый готовый пост ≤ ~15 c, все плитки достигают терминального статуса (done/failed), частичный сбой одного провайдера не валит весь batch.

---

## 3. Функциональные требования (FR)

### FR-1. Загрузка изображений
- **FR-1.1.** Product images: загрузка N штук (drag&drop + picker). Лимит N ≤ 20 (конфигурируемо).
- **FR-1.2.** Reference images: 1–2 штуки, помечаются отдельно от product.
- **FR-1.3.** Валидация на клиенте: формат (`png/jpg/webp`), размер (≤ 10 MB/файл), разрешение. Невалидные — отклоняются с понятной ошибкой до старта batch.
- **FR-1.4.** Превью всех загруженных изображений с возможностью удалить отдельное до запуска.
- **FR-1.5.** Изображения загружаются в blob-хранилище; в генерацию идут URL/handles, а не base64 в теле запроса (см. §7).

### FR-2. Параметры генерации
- **FR-2.1.** Формат вывода: `1:1`, `4:5`, `9:16` (по умолчанию `1:1`).
- **FR-2.2.** Опциональный текстовый brief (общий для batch) + опциональный per-image caption-hint.
- **FR-2.3.** Параметры формируют единый промпт-шаблон, общий для всех элементов batch (основа style consistency, см. §6.3).

### FR-3. Пакетная генерация (batch)
- **FR-3.1.** Один запуск создаёт **job** с N **items** (1 item = 1 product image → 1 пост).
- **FR-3.2.** Items обрабатываются с ограниченной конкурентностью (пул воркеров, см. §9.2), а не строго последовательно и не «всё разом».
- **FR-3.3.** Каждый item независим: сбой/ретрай одного не блокирует остальные.
- **FR-3.4.** Item-стейт-машина: `queued → running → (succeeded | failed)`; `failed` допускает ручной/авто-ретрай → снова `queued`.

### FR-4. Progressive rendering
- **FR-4.1.** UI получает обновления статуса и готовые результаты по мере поступления (стриминг, см. §8), без поллинга «в лоб».
- **FR-4.2.** Каждая плитка независимо переходит между статусами; готовое изображение показывается немедленно.
- **FR-4.3.** Глобальный индикатор: `X из N готово`, счётчик ошибок.
- **FR-4.4.** Переподключение стрима при обрыве (reconnect) без потери уже полученных результатов.

### FR-5. Reliability (надёжность генерации)
- **FR-5.1. Retries.** Транзиентные ошибки (5xx, timeout, rate-limit 429) ретраятся с экспоненциальным backoff + jitter; лимит попыток конфигурируем (по умолчанию 3).
- **FR-5.2. Multi-provider failover.** При исчерпании ретраев на провайдере item переключается на следующий провайдер в цепочке (см. §6.2). Терминальный `failed` — только когда исчерпаны все провайдеры.
- **FR-5.3. Идемпотентность.** Повторный ретрай item не плодит дубликаты результата (idempotency key на item-attempt, см. §9.4).
- **FR-5.4. Partial failure.** Job завершается со статусом `completed` (все ок) или `completed_with_errors` (часть failed); batch как целое не «падает» из-за отдельных items.
- **FR-5.5. Видимость ошибок.** Для failed-item показывается человекочитаемая причина (provider error / content policy / timeout) + какой провайдер пробовался.

### FR-6. Style consistency
- **FR-6.1.** Reference-изображения подаются на вход каждому item как style-conditioning (для провайдеров, поддерживающих image-reference).
- **FR-6.2.** Единый промпт-шаблон + единый seed-стратегия (где провайдер поддерживает seed) для согласованности.
- **FR-6.3.** При failover на провайдер без image-reference — деградация до prompt-only style (явный trade-off, помечается в метаданных результата, см. §6.2).

### FR-7. Экспорт результатов
- **FR-7.1.** Скачивание отдельного поста (оригинальное разрешение).
- **FR-7.2.** Скачивание всего batch одним zip.
- **FR-7.3.** (Full product) копируемая permalink-ссылка на batch.

### FR-8. История (Full product)
- **FR-8.1.** Сохранение job + items + результатов в БД и blob-хранилище.
- **FR-8.2.** Список прошлых batch'ей с превью и статусом.
- **FR-8.3.** Открытие прошлого batch с готовыми результатами.

---

## 4. Нефункциональные требования (NFR)

| Код | Требование | Критерий |
|---|---|---|
| NFR-1 | **Time-to-first-result** | Первый готовый пост ≤ ~15 c при N=10 (зависит от провайдера) |
| NFR-2 | **Конкурентность** | Параллельная обработка items с лимитом пула (default 4–6), без блокировки UI |
| NFR-3 | **Устойчивость** | Сбой одного провайдера/одного item не валит batch (см. FR-5) |
| NFR-4 | **Прозрачность стоимости** | Использование free-tier провайдеров; учёт квот, см. §6.4 |
| NFR-5 | **Безопасность** | API-ключи только server-side; загрузки валидируются; см. §10 |
| NFR-6 | **Observability** | Структурные логи per-item-attempt, метрики успеха/латентности/провайдера, см. §12 |
| NFR-7 | **Responsiveness** | UI адаптивен (desktop-first, рабочий mobile); сетка перетекает |
| NFR-8 | **Деплой** | Один `git push` → Vercel; без ручной инфры, см. §14 |

---

## 5. Архитектура

### 5.1. Высокоуровневая схема

```
┌─────────────────────────────────────────────────────────────┐
│ Browser (Next.js Client Components)                          │
│  • Uploader (product + reference)  • Params form             │
│  • Batch grid (progressive tiles)  • SSE client / reconnect  │
└───────────────┬───────────────────────────────┬─────────────┘
                │ POST /api/uploads (signed)      │ GET /api/jobs/:id/stream (SSE)
                │ POST /api/jobs                  │
┌───────────────▼───────────────────────────────▼─────────────┐
│ Next.js Route Handlers (Vercel Functions, server-only)       │
│  • Job orchestrator (worker pool, concurrency limit)         │
│  • Provider abstraction + failover chain                     │
│  • Retry engine (backoff + jitter)                           │
│  • Event bus → SSE stream                                    │
└───────┬───────────────────┬───────────────────┬─────────────┘
        │                   │                   │
┌───────▼──────┐   ┌────────▼────────┐  ┌───────▼──────────────┐
│ Blob storage │   │ Provider APIs    │  │ State store           │
│ (Vercel Blob)│   │  1. Gemini       │  │  • In-memory (MVP)    │
│ uploads +    │   │  2. Cloudflare   │  │  • Postgres+KV (full) │
│ results      │   │  3. Replicate    │  │                       │
└──────────────┘   └─────────────────┘  └──────────────────────┘
```

### 5.2. Frontend (Next.js App Router)
- **Server Components** для статичной оболочки; **Client Components** для интерактива (uploader, grid, SSE-клиент).
- Состояние batch — клиентский store (Zustand / React state), обновляется из SSE-событий.
- Плитка = независимый компонент, подписанный на события своего `itemId`.
- Оптимистичные плейсхолдеры создаются сразу после `POST /api/jobs` (по числу product-картинок).

### 5.2.1. Визуальный язык (UI) — наследует эстетику лендинга-вакансии
- **Палитра:** чистый белый фон (`#FFFFFF`), near-black charcoal текст (`~#1A1A1A`). Без цветовых блоков и градиентов. Единственный функциональный акцент — статусы (нейтральный/успех/ошибка), приглушённые.
- **Типографика:** sans-serif (system / `Inter`-подобный). Иерархия — весом и размером, не цветом. **ALL-CAPS** мелкие лейблы для секций/статусов («UPLOAD», «GENERATING», «FAILED»). Крупные заголовки, комфортный body ~16px.
- **Лейаут:** left-aligned, колоночный, с max-width-констрейнтом (контент не на всю ширину). Много воздуха, низкая плотность, асимметричные отступы.
- **Декор:** минимум — тонкие hr-разделители вместо карточек с тенями; границы почти отсутствуют. Мелкий приглушённый meta-текст (как date-stamp на лендинге).
- **Тон:** editorial / utilitarian-brutalist. Типографика — главный носитель дизайна; плитки результатов — сдержанные, без скруглений-теней-флоуришей.

### 5.3. Backend (Route Handlers)
- `POST /api/uploads` — выдаёт signed-upload в Vercel Blob (прямая загрузка клиент→Blob, минуя function-боди).
- `POST /api/jobs` — создаёт job + items, стартует оркестратор, возвращает `jobId`.
- `GET /api/jobs/:id/stream` — SSE-поток событий job (статусы items, результаты, прогресс).
- `POST /api/jobs/:id/items/:itemId/retry` — точечный ретрай item.
- `GET /api/jobs/:id` — снапшот состояния (для reconnect / прямого открытия).

> **Vercel-нюанс выполнения.** Долгая batch-оркестрация не должна жить в одном «висящем» request-handler'е дольше function-лимита. Базовый подход — **streaming Route Handler + Fluid Compute** (стрим держит соединение, items обрабатываются конкурентно внутри обработчика стрима). Для полноценного продакшена — вынос в durable-очередь (см. §9.3 и §15).

### 5.4. Provider Abstraction Layer
Единый интерфейс провайдера — ядро failover'а и тестируемости:

```ts
interface ImageProvider {
  id: string;                       // "gemini" | "cloudflare" | "replicate"
  supportsImageReference: boolean;  // влияет на style-conditioning
  generate(input: GenerateInput, signal: AbortSignal): Promise<GenerateResult>;
}

type GenerateInput = {
  productImageUrl: string;
  referenceImageUrls: string[];     // 1..2
  prompt: string;                   // единый шаблон + brief/hint
  aspectRatio: "1:1" | "4:5" | "9:16";
  seed?: number;
};

type GenerateResult = {
  imageBytes: Uint8Array | string;  // bytes | url
  providerId: string;
  usedImageReference: boolean;      // для метки деградации стиля
  meta: { latencyMs: number; model: string };
};
```

- Каждый провайдер — отдельный адаптер, мапящий общий контракт в свой API.
- Failover-движок ничего не знает о специфике провайдера — только об интерфейсе.

---

## 6. Провайдеры генерации и стратегия failover

### 6.1. Выбор провайдеров (free / free-trial, с поддержкой reference)

| # | Провайдер | Модель | Free-условия | Image-reference | Примечание |
|---|---|---|---|---|---|
| 1 (primary) | **Google Gemini** | Gemini 2.5 Flash Image («Nano Banana») | ~500 img/день, ~10 RPM, без карты | ✅ нативно (multimodal edit) | Лучший style-conditioning по reference |
| 2 (secondary) | **Cloudflare Workers AI** | FLUX.2 [klein] / FLUX.1 [schnell] / SDXL | 10 000 neurons/день via API | ⚠️ klein — edit; schnell/SDXL — text-only | Бесплатно через REST, edge-friendly |
| 3 (tertiary, опц.) | **Replicate** | FLUX + Redux/IP-Adapter | pay-per-use, мелкий триал | ✅ | Включается при наличии бюджета |

> **Осознанно НЕ берём:** fal.ai — free-кредиты ($20) работают **только в Sandbox/Playground, не через API**, поэтому в продуктовый failover не годятся. OpenAI `gpt-image-1` — нет рабочего free-tier. Эти решения зафиксированы как пример судейства.

### 6.2. Failover-цепочка
```
Gemini (3 ретрая) ──fail──▶ Cloudflare (3 ретрая) ──fail──▶ Replicate* ──fail──▶ item.failed
                                                            (*если сконфигурен)
```
- Переход на следующий провайдер — только после исчерпания ретраев на текущем **или** при немедленно-фатальной ошибке (auth, quota-exhausted).
- При переходе на провайдер с `supportsImageReference=false` стиль деградирует до prompt-only; результат помечается `usedImageReference=false`, и в UI плитка получает бейдж «style: prompt-only». Это честный trade-off доступность↔консистентность.
- Цепочка и лимиты ретраев — конфиг (env), а не хардкод.

### 6.3. Style consistency механика
- **Единый промпт-шаблон** на весь batch: reference подаётся как image-conditioning + текстовое описание извлечённого стиля (для prompt-only фолбэков).
- **Seed-стратегия:** фиксированный/детерминированный seed на batch там, где провайдер поддерживает, — для согласованности между постами.
- **Reference нормализация:** reference-изображения предобрабатываются один раз (resize/encode) и переиспользуются для всех items.

### 6.4. Учёт квот (NFR-4)
- Счётчик использований на провайдер в пределах сессии/окна; при приближении к дневному лимиту Gemini — упреждающее переключение на Cloudflare.
- Квоты/лимиты — в конфиге, чтобы менять без передеплоя кода.

---

## 7. Модель данных и API-контракты

### 7.1. Сущности
```ts
type Job = {
  id: string;
  status: "running" | "completed" | "completed_with_errors" | "failed";
  params: { aspectRatio: AspectRatio; brief?: string };
  referenceImageUrls: string[];
  items: Item[];
  createdAt: string;
};

type Item = {
  id: string;
  jobId: string;
  productImageUrl: string;
  status: "queued" | "running" | "succeeded" | "failed";
  attempts: Attempt[];
  result?: { imageUrl: string; providerId: string; usedImageReference: boolean };
  error?: { code: string; message: string; lastProviderId: string };
};

type Attempt = {
  providerId: string;
  startedAt: string;
  finishedAt?: string;
  outcome: "success" | "retryable_error" | "fatal_error";
  errorMessage?: string;
};
```

### 7.2. Эндпоинты (контракты)
| Метод / путь | Тело / параметры | Ответ |
|---|---|---|
| `POST /api/uploads` | `{ filename, contentType, kind: "product"|"reference" }` | `{ uploadUrl, blobUrl }` (signed) |
| `POST /api/jobs` | `{ productImageUrls[], referenceImageUrls[], params }` | `{ jobId }` |
| `GET /api/jobs/:id/stream` | — (SSE) | поток событий (§8.2) |
| `GET /api/jobs/:id` | — | `Job` (снапшот) |
| `POST /api/jobs/:id/items/:itemId/retry` | — | `{ ok: true }` |

---

## 8. Progressive rendering (стриминг)

### 8.1. Транспорт
- **Server-Sent Events (SSE)** через streaming Route Handler — проще, чем WebSocket, и достаточно для односторонних серверных апдейтов. Нативный reconnect через `Last-Event-ID`.
- Альтернатива — стриминг через `ReadableStream` в Route Handler.

### 8.2. События стрима
```
event: item.status   data: { itemId, status }
event: item.result   data: { itemId, imageUrl, providerId, usedImageReference }
event: item.error    data: { itemId, code, message, lastProviderId }
event: job.progress  data: { done, failed, total }
event: job.done      data: { status }
```

### 8.3. Reconnect-семантика
- Клиент при обрыве переподключается; сервер по `Last-Event-ID` или через `GET /api/jobs/:id` восстанавливает снапшот, UI домерживает дельту. Уже показанные результаты не теряются (FR-4.4).

---

## 9. Reliability deep-dive

### 9.1. Retry policy
- Ретраятся: `429`, `5xx`, network timeout, провайдерские «temporarily unavailable».
- Не ретраятся (фатальные): `401/403` (auth), content-policy reject, invalid-input → сразу failover/fail.
- Backoff: `base * 2^attempt + jitter`, cap по max-delay; max-attempts конфигурируем.

### 9.2. Concurrency control
- Пул воркеров с лимитом параллелизма (default 4–6) поверх очереди items — баланс между скоростью и rate-limit'ами провайдеров.
- Per-provider rate-limiter (token bucket) уважает RPM провайдера (например, ~10 RPM Gemini).

### 9.3. Durability (Full product)
- Для продакшена batch-оркестрация выносится в durable-очередь (Vercel Queues / внешний воркер), чтобы переживать рестарты функций и таймауты. В MVP — in-flight в рамках streaming-обработчика (см. §15 trade-off).

### 9.4. Идемпотентность
- `idempotencyKey = hash(itemId + attemptNumber)`; повторная доставка/ретрай не создаёт дубль результата. Результат пишется в Blob по детерминированному ключу.

### 9.5. Партиальные сбои
- Job агрегирует исходы items; терминальный статус job — `completed` либо `completed_with_errors`. Failed-items доступны для точечного ретрая без перезапуска batch.

---

## 10. Безопасность

- **Секреты только server-side.** API-ключи провайдеров — в Vercel env, никогда не уходят в браузер. Все вызовы провайдеров — из Route Handlers.
- **Загрузки.** Валидация content-type/size на клиенте и сервере; signed-upload в Blob с ограничением типа и размера.
- **Rate-limiting** публичных эндпоинтов (`POST /api/jobs`) для защиты от abuse (basic per-IP).
- **Контент-policy.** Ошибки модерации провайдера обрабатываются как фатальные для item с понятным сообщением (без падения batch).
- **Изоляция данных** (Full product, если будет multi-user) — batch привязан к сессии/пользователю.

---

## 11. Хранилище и persistence

| Слой | MVP | Full product |
|---|---|---|
| Загрузки/результаты | Vercel Blob | Vercel Blob (+ lifecycle/cleanup) |
| Состояние job/items | In-memory (per-process) | Postgres (Neon) — job/item/attempt |
| Эфемерный прогресс / pub-sub | In-memory event bus | KV/Redis (Upstash) для координации воркеров |
| История | — | список batch'ей из БД |

---

## 12. Observability

- **Структурные логи** на каждый item-attempt: `jobId, itemId, attempt, providerId, outcome, latencyMs, errorCode`.
- **Метрики:** success-rate по провайдерам, доля failover'ов, p50/p95 латентности генерации, доля prompt-only деградаций.
- **Трейс batch'а:** агрегированная сводка по завершении (сколько success/failed, какой провайдер сколько отработал).
- Вывод — в Vercel logs; (Full) экспорт в внешний sink при необходимости.

---

## 13. Тестирование

- **Unit:** retry-движок (backoff/jitter, классификация ошибок), failover-логика (переключение цепочки), provider-адаптеры (мапперы запрос/ответ) с замоканными HTTP.
- **Provider mock:** фейковый провайдер с управляемыми сбоями (timeout/429/fatal) — для детерминированной проверки reliability-сценариев без реальных вызовов.
- **Integration:** `POST /api/jobs` → стрим событий → терминальные статусы items (с mock-провайдером).
- **Manual E2E:** реальный batch на Gemini + принудительный фейл primary → проверка failover на Cloudflare + бейдж prompt-only.
- Покрытие — точечное по reliability-ядру (оно ценнее всего); UI-тесты — минимально (см. приоритеты §1).

---

## 14. Деплой

- **Vercel**, импорт из Git; preview-деплой на каждый push, production — на main.
- **Env:** `GEMINI_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, (опц.) `REPLICATE_API_TOKEN`, `BLOB_READ_WRITE_TOKEN`, (Full) `DATABASE_URL`, `KV_URL`.
- **Fluid Compute** включён для длительного стрима; конфиг лимитов функций под batch-длительность.
- Zero manual infra (NFR-8).

---

## 15. Scope: MVP (half-day) vs Full product — демаркация judgment

> Это раздел, демонстрирующий **judgment**: что строится сразу, что осознанно откладывается и почему.

### ✅ В MVP (core, обязательно)
- Upload product (N) + reference (1–2), валидация.
- Batch-генерация с конкурентным пулом.
- **Reliability-ядро:** retries (backoff+jitter), multi-provider failover Gemini→Cloudflare, partial-failure, точечный retry.
- **Progressive rendering** через SSE с reconnect.
- Style consistency: единый промпт-шаблон + reference-conditioning + бейдж деградации.
- Экспорт: отдельный пост + zip.
- Деплой на Vercel.

### 🔶 Full product (за пределами half-day, «целевое видение»)
- Persistence (Postgres + Blob), история batch'ей, permalinks.
- Durable-очередь (Vercel Queues) вместо in-flight оркестрации — переживание рестартов/таймаутов.
- Third провайдер (Replicate) с IP-Adapter для лучшей style-consistency в фолбэке.
- Auth / multi-user изоляция.
- Расширенная observability (внешний sink, дашборды), алерты на провайдерские деградации.
- KV/Redis-координация распределённых воркеров.
- Полноценный тест-набор + CI.

### ⛔ Осознанно вне scope (с обоснованием)
| Опущено | Почему |
|---|---|
| fal.ai в failover | free-кредиты не работают через API |
| OpenAI `gpt-image-1` | нет рабочего free-tier под условия челленджа |
| Тонкая UI-полировка/анимации | оценка явно ставит output/judgment > polish |
| Видео/карусели | вне формулировки задачи (статичные посты) |
| Тяжёлый caption/copy-генератор | фокус задачи — изображения; текст-хинт достаточен |

---

## 16. Риски и открытые вопросы

| Риск / вопрос | Влияние | Митигация / решение |
|---|---|---|
| Дневной free-лимит Gemini (~500/день) исчерпан | batch уходит в prompt-only фолбэк | упреждающее переключение по квоте (§6.4), бейдж деградации |
| Cloudflare schnell/SDXL не держат reference-стиль | визуальная неконсистентность в фолбэке | пометка `prompt-only`, текстовое описание стиля в промпте; (Full) Replicate IP-Adapter |
| Function-таймаут при долгом batch | оборванная оркестрация | streaming + Fluid Compute (MVP); durable queue (Full) |
| Rate-limit провайдера при большом N | 429-штормы | per-provider token-bucket + конкуренси-пул (§9.2) |
| Стоимость reference-предобработки | латентность | one-time нормализация reference на job (§6.3) |

> **Решение по auth:** аутентификации нет. Приложение single-user (один сеанс — один пользователь), без логина и multi-user изоляции. Зафиксировано.

---

### Резюме одним абзацем
Batch Creative Studio — Next.js/Vercel-приложение, где пользователь грузит N product-фото + 1–2 reference, а система пакетно генерирует N стилизованных постов с прогрессивным рендером. Архитектурное ядро — provider-abstraction с failover-цепочкой (Gemini → Cloudflare → опц. Replicate), retry-движок и SSE-стрим. Reliability и style-consistency — first-class требования; persistence, durable-очередь и третий провайдер вынесены в Full-product scope как осознанный trade-off под half-day.
