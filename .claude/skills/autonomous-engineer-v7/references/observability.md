# Observability — Logging, Metrics, Tracing

## The Three Pillars

```
LOGS    → What happened? (events, errors, debug)
METRICS → How much? How often? (counters, gauges, histograms)
TRACES  → Where did time go? (request flow across services)
```

**Rule: If you can't observe it, you can't debug it. Build observability from day one.**

---

## 1. Structured Logging

### Format (JSON, always)

```json
{
  "timestamp": "2026-03-20T10:30:00.000Z",
  "level": "info",
  "message": "Order created",
  "service": "order-service",
  "traceId": "abc123",
  "spanId": "def456",
  "userId": "user_789",
  "orderId": "order_012",
  "amount": 99.99,
  "duration_ms": 45
}
```

### Log Levels

| Level | Use When | Example |
|-------|----------|---------|
| `error` | Something failed, needs attention | DB connection failed |
| `warn` | Something unexpected, but handled | Rate limit approaching |
| `info` | Normal operations, key events | User logged in, order created |
| `debug` | Development details | SQL query, cache hit/miss |

### What to Log (Always)

```
✓ Request start (method, path, userId)
✓ Request end (status, duration_ms)
✓ Errors (full stack trace, context)
✓ External API calls (service, duration, status)
✓ Database queries (query type, table, duration) — DEBUG only
✓ Business events (order created, payment processed)
✓ Security events (login, logout, permission denied)
```

### What NOT to Log

```
✗ Passwords, tokens, API keys
✗ Full credit card numbers
✗ Personal data (PII) unless required
✗ Request/response bodies (too verbose)
✗ Health check spam
```

### Implementation (NestJS)

```typescript
// logger.service.ts
import { Injectable, LoggerService } from '@nestjs/common';

@Injectable()
export class AppLogger implements LoggerService {
  private formatLog(level: string, message: string, context?: object) {
    return JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message,
      service: process.env.SERVICE_NAME,
      ...context,
    });
  }

  log(message: string, context?: object) {
    console.log(this.formatLog('info', message, context));
  }

  error(message: string, trace?: string, context?: object) {
    console.error(this.formatLog('error', message, { ...context, trace }));
  }

  warn(message: string, context?: object) {
    console.warn(this.formatLog('warn', message, context));
  }

  debug(message: string, context?: object) {
    if (process.env.LOG_LEVEL === 'debug') {
      console.debug(this.formatLog('debug', message, context));
    }
  }
}
```

### Implementation (Next.js)

```typescript
// lib/logger.ts
export const logger = {
  info: (message: string, data?: object) => {
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'info',
      message,
      ...data,
    }));
  },
  error: (message: string, error?: Error, data?: object) => {
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'error',
      message,
      error: error?.message,
      stack: error?.stack,
      ...data,
    }));
  },
};
```

---

## 2. Metrics

### Key Metrics (RED Method)

```
Rate    → Requests per second
Errors  → Error rate (%)
Duration → Response time (p50, p95, p99)
```

### Standard Metrics to Track

| Metric | Type | What It Tells You |
|--------|------|-------------------|
| `http_requests_total` | Counter | Traffic volume |
| `http_request_duration_seconds` | Histogram | Response time distribution |
| `http_requests_errors_total` | Counter | Error volume |
| `db_query_duration_seconds` | Histogram | Database performance |
| `db_connections_active` | Gauge | Connection pool health |
| `cache_hits_total` | Counter | Cache effectiveness |
| `cache_misses_total` | Counter | Cache effectiveness |
| `queue_jobs_total` | Counter | Background job volume |
| `queue_jobs_failed_total` | Counter | Job failures |
| `external_api_duration_seconds` | Histogram | Third-party latency |

### Implementation (Prometheus + NestJS)

```typescript
// metrics.service.ts
import { Injectable } from '@nestjs/common';
import { Counter, Histogram, Gauge, Registry } from 'prom-client';

@Injectable()
export class MetricsService {
  private readonly registry = new Registry();
  
  readonly httpRequestsTotal = new Counter({
    name: 'http_requests_total',
    help: 'Total HTTP requests',
    labelNames: ['method', 'path', 'status'],
    registers: [this.registry],
  });

  readonly httpRequestDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration',
    labelNames: ['method', 'path'],
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
    registers: [this.registry],
  });

  readonly dbConnections = new Gauge({
    name: 'db_connections_active',
    help: 'Active database connections',
    registers: [this.registry],
  });

  getMetrics() {
    return this.registry.metrics();
  }
}
```

### Alerting Thresholds

| Metric | Warning | Critical |
|--------|---------|----------|
| Error rate | > 1% | > 5% |
| p99 latency | > 1s | > 3s |
| DB connections | > 80% pool | > 95% pool |
| CPU | > 70% | > 90% |
| Memory | > 80% | > 95% |
| Disk | > 80% | > 95% |

---

## 3. Distributed Tracing

### Concepts

```
Trace  → Full request journey (across services)
Span   → Single operation within a trace
TraceId → Unique ID for the full request
SpanId  → Unique ID for this operation
ParentSpanId → The span that called this one
```

### Propagate Trace Context

```typescript
// middleware/tracing.ts
import { v4 as uuidv4 } from 'uuid';

export function tracingMiddleware(req, res, next) {
  // Get trace ID from header or create new
  req.traceId = req.headers['x-trace-id'] || uuidv4();
  req.spanId = uuidv4();
  
  // Set on response for downstream
  res.setHeader('x-trace-id', req.traceId);
  
  // Add to all logs
  req.log = (message, data) => {
    logger.info(message, {
      traceId: req.traceId,
      spanId: req.spanId,
      ...data,
    });
  };
  
  next();
}
```

### Pass to External Calls

```typescript
// When calling other services
async function callOrderService(orderId: string, traceId: string) {
  return fetch(`${ORDER_SERVICE_URL}/orders/${orderId}`, {
    headers: {
      'x-trace-id': traceId,
      'x-parent-span-id': currentSpanId,
    },
  });
}
```

### Tools

| Tool | Type | Best For |
|------|------|----------|
| Jaeger | Open source | Self-hosted tracing |
| Zipkin | Open source | Simple tracing |
| Datadog | SaaS | Full observability |
| New Relic | SaaS | APM + tracing |
| Honeycomb | SaaS | High-cardinality debugging |
| Sentry | SaaS | Error tracking + tracing |

---

## 4. Health Checks

### Standard Endpoints

```
GET /health        → Basic liveness (am I running?)
GET /health/ready  → Readiness (can I serve traffic?)
GET /health/live   → Liveness (am I stuck?)
```

### Implementation

```typescript
// health.controller.ts
@Controller('health')
export class HealthController {
  constructor(
    private db: DatabaseService,
    private redis: RedisService,
  ) {}

  @Get()
  async check() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  @Get('ready')
  async readiness() {
    const checks = {
      database: await this.checkDb(),
      redis: await this.checkRedis(),
    };
    
    const allHealthy = Object.values(checks).every(c => c.status === 'ok');
    
    return {
      status: allHealthy ? 'ok' : 'degraded',
      checks,
      timestamp: new Date().toISOString(),
    };
  }

  private async checkDb() {
    try {
      await this.db.query('SELECT 1');
      return { status: 'ok' };
    } catch (e) {
      return { status: 'error', message: e.message };
    }
  }

  private async checkRedis() {
    try {
      await this.redis.ping();
      return { status: 'ok' };
    } catch (e) {
      return { status: 'error', message: e.message };
    }
  }
}
```

---

## 5. Error Tracking

### What to Capture

```
✓ Error message
✓ Stack trace
✓ User ID (if authenticated)
✓ Request URL, method, headers
✓ Request body (sanitized)
✓ Environment (production, staging)
✓ Release version
✓ Trace ID
```

### Implementation (Sentry)

```typescript
// sentry.ts
import * as Sentry from '@sentry/node';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
  release: process.env.APP_VERSION,
  tracesSampleRate: 0.1, // 10% of requests
});

// Error handler middleware
export function errorHandler(err, req, res, next) {
  Sentry.withScope((scope) => {
    scope.setUser({ id: req.userId });
    scope.setTag('traceId', req.traceId);
    scope.setContext('request', {
      method: req.method,
      url: req.url,
      headers: sanitizeHeaders(req.headers),
    });
    Sentry.captureException(err);
  });

  res.status(500).json({ error: 'Internal server error' });
}
```

---

## 6. Dashboards

### Must-Have Panels

```
1. Request rate (per minute)
2. Error rate (%)
3. p50, p95, p99 latency
4. Active users (if applicable)
5. Database query time
6. Cache hit rate
7. Queue depth
8. CPU / Memory / Disk
```

### Tool Options

| Tool | Type | Cost |
|------|------|------|
| Grafana | Dashboards | Free (self-host) |
| Datadog | Full observability | $$$$ |
| New Relic | APM + dashboards | $$$ |
| Axiom | Logs + dashboards | Free tier |
| Better Stack | Logs + uptime | Free tier |

---

## Quick Setup Checklist

```
□ Structured JSON logging
□ Log levels configured (info in prod, debug in dev)
□ Request/response logging middleware
□ Error tracking (Sentry or similar)
□ Health check endpoints
□ Basic metrics (rate, errors, duration)
□ Trace ID propagation
□ Alerting on error rate + latency
□ Dashboard with key metrics
```

---

## Observability by Stage

| Stage | Minimum | Recommended |
|-------|---------|-------------|
| **MVP** | Structured logs + Sentry | + Basic metrics |
| **Launch** | + Health checks + Alerts | + Dashboards |
| **Growth** | + Full metrics + Tracing | + APM tool |
| **Scale** | + Distributed tracing | + Custom dashboards |
