# Production Operations — CI/CD, Docker, Deployments, Disaster Recovery

## The Gap This Fills

The skill teaches design and code. This file teaches:
- How to ship code safely (CI/CD)
- How to run code reliably (Docker)
- How to deploy without downtime (strategies)
- How to recover from disasters (backups)

---

## 1. CI/CD Pipelines

### GitHub Actions — Standard Template

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

env:
  NODE_VERSION: '20'
  
jobs:
  test:
    runs-on: ubuntu-latest
    
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: test
          POSTGRES_PASSWORD: test
          POSTGRES_DB: test
        ports:
          - 5432:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
      
      redis:
        image: redis:7
        ports:
          - 6379:6379
    
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'npm'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Lint
        run: npm run lint
      
      - name: Type check
        run: npm run type-check
      
      - name: Run tests
        run: npm test
        env:
          DATABASE_URL: postgresql://test:test@localhost:5432/test
          REDIS_URL: redis://localhost:6379
      
      - name: Build
        run: npm run build

  deploy-staging:
    needs: test
    if: github.ref == 'refs/heads/develop'
    runs-on: ubuntu-latest
    environment: staging
    
    steps:
      - uses: actions/checkout@v4
      
      - name: Deploy to staging
        run: |
          # Railway / Vercel / your platform
          npx railway up --environment staging

  deploy-production:
    needs: test
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    environment: production
    
    steps:
      - uses: actions/checkout@v4
      
      - name: Deploy to production
        run: |
          npx railway up --environment production
```

### Pipeline Stages

```
┌─────────┐    ┌──────┐    ┌───────────┐    ┌────────┐    ┌────────┐
│  Lint   │───▶│ Test │───▶│   Build   │───▶│ Deploy │───▶│ Verify │
└─────────┘    └──────┘    └───────────┘    └────────┘    └────────┘
     │              │              │              │              │
     ▼              ▼              ▼              ▼              ▼
  ESLint        Unit +        Compile +      Staging       Health
  Prettier     Integration    Bundle         then Prod     checks
```

### When to Run What

| Trigger | Lint | Test | Build | Deploy Staging | Deploy Prod |
|---------|------|------|-------|----------------|-------------|
| PR opened | ✓ | ✓ | ✓ | ✗ | ✗ |
| Push to develop | ✓ | ✓ | ✓ | ✓ | ✗ |
| Push to main | ✓ | ✓ | ✓ | ✗ | ✓ |
| Manual trigger | Optional | Optional | Optional | ✓ | ✓ |

---

## 2. Docker Configuration

### Dockerfile — Node.js (Production)

```dockerfile
# Dockerfile
FROM node:20-alpine AS base

# Install dependencies only
FROM base AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

# Build the app
FROM base AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Production image
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production

# Create non-root user
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 appuser

# Copy built assets
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./

USER appuser

EXPOSE 3000

CMD ["node", "dist/main.js"]
```

### docker-compose.yml — Local Development

```yaml
# docker-compose.yml
version: '3.8'

services:
  app:
    build: .
    ports:
      - "3000:3000"
    environment:
      - DATABASE_URL=postgresql://dev:dev@db:5432/app
      - REDIS_URL=redis://redis:6379
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_started
    volumes:
      - .:/app
      - /app/node_modules

  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: dev
      POSTGRES_PASSWORD: dev
      POSTGRES_DB: app
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U dev -d app"]
      interval: 5s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data

volumes:
  postgres_data:
  redis_data:
```

### Makefile Commands

```makefile
# Makefile
.PHONY: dev build test deploy

dev:
	docker compose up -d
	npm run dev

build:
	docker build -t app:latest .

test:
	docker compose -f docker-compose.test.yml up --abort-on-container-exit

deploy-staging:
	docker build -t app:staging .
	docker push registry/app:staging
	kubectl apply -f k8s/staging/

deploy-prod:
	docker build -t app:$(VERSION) .
	docker push registry/app:$(VERSION)
	kubectl apply -f k8s/production/

logs:
	docker compose logs -f app

clean:
	docker compose down -v
```

---

## 3. Deployment Strategies

### Blue-Green Deployment

```
Current: Blue (v1.0) ──── Load Balancer ──── Users
                              │
New:     Green (v1.1) ────────┘ (waiting)

After switch:
Old:     Blue (v1.0) ──── (standby for rollback)
                              │
Current: Green (v1.1) ──── Load Balancer ──── Users
```

**When to use:** Zero downtime required, instant rollback needed
**Tradeoff:** 2x infrastructure during deploy

### Canary Deployment

```
                    ┌── 95% ──▶ v1.0 (stable)
Users ── LB ────────┤
                    └── 5% ───▶ v1.1 (canary)

Monitor for 30min, if healthy:
                    ┌── 50% ──▶ v1.0
Users ── LB ────────┤
                    └── 50% ──▶ v1.1

Finally:
Users ── LB ──────────────────▶ v1.1 (100%)
```

**When to use:** Risky changes, need to validate with real traffic
**Tradeoff:** Slower rollout, complexity

### Rolling Update

```
Replicas: [v1.0] [v1.0] [v1.0] [v1.0]

Step 1:   [v1.0] [v1.0] [v1.0] [v1.1]
Step 2:   [v1.0] [v1.0] [v1.1] [v1.1]
Step 3:   [v1.0] [v1.1] [v1.1] [v1.1]
Step 4:   [v1.1] [v1.1] [v1.1] [v1.1]
```

**When to use:** Kubernetes default, gradual transition
**Tradeoff:** Both versions run during transition

### Decision Tree

```
START
  │
  ├─ Zero downtime required?
  │   ├─ YES → Blue-Green or Rolling
  │   └─ NO → Simple replace
  │
  ├─ Need instant rollback?
  │   └─ YES → Blue-Green
  │
  ├─ Risky change, need real traffic validation?
  │   └─ YES → Canary
  │
  └─ DEFAULT → Rolling Update (Kubernetes default)
```

---

## 4. Disaster Recovery

### Backup Strategy

```
┌─────────────┐
│ PostgreSQL  │
└──────┬──────┘
       │
       ├── Every hour: WAL archiving (point-in-time recovery)
       │
       ├── Every day: Full backup (pg_dump)
       │
       └── Every week: Offsite copy (S3/GCS)
```

### PostgreSQL Backup Script

```bash
#!/bin/bash
# backup.sh

set -e

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="/backups"
S3_BUCKET="s3://my-backups/postgres"

# Create backup
pg_dump -Fc $DATABASE_URL > "$BACKUP_DIR/backup_$TIMESTAMP.dump"

# Upload to S3
aws s3 cp "$BACKUP_DIR/backup_$TIMESTAMP.dump" "$S3_BUCKET/"

# Keep only last 7 local backups
ls -t $BACKUP_DIR/*.dump | tail -n +8 | xargs rm -f

# Verify backup
pg_restore --list "$BACKUP_DIR/backup_$TIMESTAMP.dump" > /dev/null

echo "Backup completed: backup_$TIMESTAMP.dump"
```

### Restore Procedure

```bash
#!/bin/bash
# restore.sh

BACKUP_FILE=$1

if [ -z "$BACKUP_FILE" ]; then
  echo "Usage: ./restore.sh backup_20260320_120000.dump"
  exit 1
fi

# Download from S3 if needed
if [ ! -f "$BACKUP_FILE" ]; then
  aws s3 cp "s3://my-backups/postgres/$BACKUP_FILE" .
fi

# Restore
pg_restore -d $DATABASE_URL --clean --if-exists "$BACKUP_FILE"

echo "Restore completed from $BACKUP_FILE"
```

### Recovery Time Objectives

| Disaster | RTO | RPO | Solution |
|----------|-----|-----|----------|
| App crash | < 1 min | 0 | Auto-restart (K8s) |
| DB corruption | < 1 hour | < 1 hour | Point-in-time recovery |
| Region outage | < 4 hours | < 1 hour | Multi-region replica |
| Data deletion | < 1 hour | < 1 day | Daily backups |

RTO = Recovery Time Objective (how fast to recover)
RPO = Recovery Point Objective (how much data loss acceptable)

---

## 5. Queue Patterns

### Dead Letter Queue

```
┌────────────┐     ┌─────────┐     ┌───────────┐
│  Producer  │────▶│  Queue  │────▶│  Consumer │
└────────────┘     └────┬────┘     └─────┬─────┘
                        │                │
                        │     fails 3x   │
                        │                ▼
                        │         ┌──────────────┐
                        └────────▶│ Dead Letter  │
                                  │    Queue     │
                                  └──────────────┘
                                         │
                                         ▼
                                  Manual review +
                                  reprocess or discard
```

### BullMQ Implementation

```typescript
// queue.ts
import { Queue, Worker, QueueEvents } from 'bullmq';

const connection = { host: 'localhost', port: 6379 };

// Main queue
const emailQueue = new Queue('email', { connection });

// Dead letter queue
const deadLetterQueue = new Queue('email-dlq', { connection });

// Worker with retry and DLQ
const worker = new Worker('email', async (job) => {
  await sendEmail(job.data);
}, {
  connection,
  limiter: {
    max: 100,      // 100 jobs
    duration: 1000 // per second
  }
});

// Move to DLQ after 3 failures
worker.on('failed', async (job, err) => {
  if (job.attemptsMade >= 3) {
    await deadLetterQueue.add('failed-email', {
      originalJob: job.data,
      error: err.message,
      failedAt: new Date().toISOString()
    });
  }
});

// Add job with retry config
await emailQueue.add('welcome', { to: 'user@example.com' }, {
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 1000  // 1s, 2s, 4s
  }
});
```

### Retry Strategy

| Failure Type | Retry? | Backoff | Max Attempts |
|--------------|--------|---------|--------------|
| Network timeout | Yes | Exponential | 5 |
| Rate limited | Yes | Fixed (60s) | 3 |
| Invalid data | No | — | 1 |
| Auth failure | No | — | 1 |

---

## 6. Rate Limiting

### Redis Implementation

```typescript
// rate-limiter.ts
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL);

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
}

export async function checkRateLimit(
  key: string,
  limit: number,
  windowSeconds: number
): Promise<RateLimitResult> {
  const now = Date.now();
  const windowStart = now - (windowSeconds * 1000);
  const redisKey = `ratelimit:${key}`;

  // Remove old entries, add current, count, set expiry
  const pipeline = redis.pipeline();
  pipeline.zremrangebyscore(redisKey, 0, windowStart);
  pipeline.zadd(redisKey, now, `${now}`);
  pipeline.zcard(redisKey);
  pipeline.expire(redisKey, windowSeconds);
  
  const results = await pipeline.exec();
  const count = results[2][1] as number;

  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    resetAt: new Date(now + (windowSeconds * 1000))
  };
}

// Usage in middleware
export async function rateLimitMiddleware(req, res, next) {
  const key = req.user?.id || req.ip;
  const result = await checkRateLimit(key, 100, 60); // 100 req/min

  res.setHeader('X-RateLimit-Limit', '100');
  res.setHeader('X-RateLimit-Remaining', result.remaining);
  res.setHeader('X-RateLimit-Reset', result.resetAt.toISOString());

  if (!result.allowed) {
    return res.status(429).json({
      error: 'Too many requests',
      retryAfter: Math.ceil((result.resetAt.getTime() - Date.now()) / 1000)
    });
  }

  next();
}
```

### Rate Limit Tiers

| Tier | Limit | Window | Use Case |
|------|-------|--------|----------|
| Anonymous | 20 | 1 min | Public endpoints |
| Free | 100 | 1 min | Authenticated users |
| Pro | 1000 | 1 min | Paid users |
| API | 10,000 | 1 min | Server-to-server |

---

## 7. API Versioning

### URL Path Versioning (Recommended)

```
GET /api/v1/users
GET /api/v2/users  ← new response format
```

### Migration Strategy

```
Phase 1: Add v2 alongside v1
  /api/v1/users ✓ (current)
  /api/v2/users ✓ (new)

Phase 2: Deprecation notice (6 months)
  /api/v1/users ✓ + Sunset header
  /api/v2/users ✓

Phase 3: Redirect (3 months)
  /api/v1/users → 301 to /api/v2/users
  /api/v2/users ✓

Phase 4: Remove
  /api/v1/users → 410 Gone
  /api/v2/users ✓
```

### Sunset Header

```typescript
// Add to v1 responses during deprecation
res.setHeader('Sunset', 'Sat, 20 Sep 2026 00:00:00 GMT');
res.setHeader('Deprecation', 'true');
res.setHeader('Link', '</api/v2/users>; rel="successor-version"');
```

---

## Quick Reference

### Checklist Before Going Live

```
□ CI/CD pipeline running (lint, test, build, deploy)
□ Docker images building correctly
□ Health check endpoints (/health, /health/ready)
□ Backup script scheduled (daily minimum)
□ Restore tested (actually restored to verify)
□ Rate limiting enabled
□ Dead letter queue configured
□ Monitoring and alerting set up
□ Rollback procedure documented and tested
```
