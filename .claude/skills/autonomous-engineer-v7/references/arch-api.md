# Architecture Reference — APIs & Microservices

## Service Design Principles

1. **Single responsibility** — each service owns exactly one bounded context
2. **API-first** — define the contract (OpenAPI) before implementation
3. **Database per service** — no shared databases between services
4. **Async by default** — use events for cross-service communication
5. **Sync only when necessary** — REST/gRPC only when the caller needs an immediate answer

---

## Recommended Stack

| Concern | Technology |
|---------|-----------|
| Runtime | Node.js (TypeScript) or Python (FastAPI) |
| Inter-service sync | gRPC or REST |
| Inter-service async | Apache Kafka or RabbitMQ |
| API Gateway | Kong or AWS API Gateway |
| Service discovery | Kubernetes DNS or Consul |
| Config | DB config table + env vars |
| Secrets | AWS Secrets Manager / Vault |
| Tracing | OpenTelemetry + Jaeger |

---

## Service Folder Structure

```
service-name/
├── src/
│   ├── api/                # HTTP/gRPC handlers (thin layer)
│   │   ├── routes/
│   │   ├── validators/     # Input schemas (Zod/Pydantic)
│   │   └── openapi/        # OpenAPI spec
│   ├── domain/             # Pure business logic (no I/O)
│   │   ├── entities/
│   │   ├── use-cases/
│   │   └── events/         # Domain event definitions
│   ├── infra/              # Adapters to external systems
│   │   ├── db/
│   │   │   ├── migrations/
│   │   │   ├── repositories/
│   │   │   └── seeds/
│   │   ├── messaging/      # Kafka/RabbitMQ producers/consumers
│   │   └── cache/
│   └── common/
│       ├── config.service.ts   # DB-driven config (same as arch-web)
│       ├── logger.ts           # Structured JSON logger
│       └── health.ts           # /health + /ready endpoints
├── proto/                  # gRPC definitions (if applicable)
├── Dockerfile
├── docker-compose.yml      # For local dev with dependencies
└── .env.example
```

---

## Idempotency Pattern

All mutation endpoints must be idempotency-safe:

```sql
CREATE TABLE idempotency_keys (
  key           VARCHAR(255) PRIMARY KEY,
  request_hash  TEXT NOT NULL,
  response      JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL
);
CREATE INDEX idempotency_keys_expires ON idempotency_keys(expires_at);
```

```typescript
// Middleware: check idempotency key before processing
async function idempotencyMiddleware(req, res, next) {
  const key = req.headers['idempotency-key'];
  if (!key) return next();

  const existing = await db.query(
    'SELECT response FROM idempotency_keys WHERE key=$1 AND expires_at > NOW()', [key]
  );
  if (existing) return res.json(existing.response);

  // Store response after processing
  res.on('finish', () => {
    db.query(
      'INSERT INTO idempotency_keys VALUES ($1, $2, $3, NOW(), NOW() + INTERVAL \'24 hours\')',
      [key, hashRequest(req), res.locals.responseBody]
    );
  });
  next();
}
```

---

## OpenAPI-First Workflow

1. Write the OpenAPI spec in `/src/api/openapi/spec.yaml`
2. Generate types from it: `openapi-typescript spec.yaml -o types.ts`
3. Implement handlers to satisfy the spec
4. Validate at runtime against the spec (use `express-openapi-validator`)

This ensures the contract is always accurate and client SDKs can be auto-generated.

---

## Kafka Event Pattern

```typescript
// Domain events are typed and versioned
interface OrderCreatedEvent {
  eventType: 'order.created';
  eventVersion: '1.0';
  eventId: string;         // UUID for deduplication
  occurredAt: string;      // ISO 8601
  aggregateId: string;     // orderId
  payload: {
    orderId: string;
    userId: string;
    items: OrderItem[];
    totalCents: number;
  };
}

// Consumers must be idempotent — they may receive the same event twice
async function handleOrderCreated(event: OrderCreatedEvent) {
  const alreadyProcessed = await checkProcessed(event.eventId);
  if (alreadyProcessed) return;

  await processOrder(event.payload);
  await markProcessed(event.eventId);
}
```

---

## Health Check Standard

```typescript
// Every service MUST expose these endpoints
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: SERVICE_NAME, version: process.env.APP_VERSION });
});

app.get('/ready', async (req, res) => {
  const checks = await Promise.allSettled([
    db.query('SELECT 1'),
    redis.ping(),
  ]);
  const allHealthy = checks.every(c => c.status === 'fulfilled');
  res.status(allHealthy ? 200 : 503).json({
    status: allHealthy ? 'ready' : 'not_ready',
    checks: { db: checks[0].status, cache: checks[1].status }
  });
});
```
