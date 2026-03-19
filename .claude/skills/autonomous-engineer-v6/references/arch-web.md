# Architecture Reference — Web Apps (Frontend + Backend)

## Recommended Stack (default, adjust to user's constraints)

| Layer | Technology | Why |
|-------|-----------|-----|
| Frontend | Next.js (App Router) | SSR, RSC, excellent DX |
| API | tRPC or REST (NestJS/FastAPI) | Type-safe or explicit contract |
| Auth | Auth.js or Clerk | Battle-tested, low maintenance |
| Database | PostgreSQL + Prisma/Drizzle | Relational, type-safe ORM |
| Cache | Redis (Upstash for serverless) | Fast key-value, sessions |
| Queue | BullMQ (Redis-backed) | Background jobs |
| Storage | S3-compatible | Files/uploads |
| Search | Typesense or Postgres FTS | Depends on complexity |

---

## Folder Structure

```
/
├── apps/
│   ├── web/                    # Next.js frontend
│   │   ├── app/                # App Router pages
│   │   ├── components/         # UI components
│   │   ├── hooks/              # Custom React hooks
│   │   └── lib/                # Client utilities
│   └── api/                    # Backend (NestJS or standalone)
│       ├── src/
│       │   ├── modules/        # Feature modules (bounded contexts)
│       │   │   └── [feature]/
│       │   │       ├── [feature].controller.ts
│       │   │       ├── [feature].service.ts
│       │   │       ├── [feature].repository.ts
│       │   │       ├── [feature].schema.ts    # Zod validation
│       │   │       └── [feature].types.ts
│       │   ├── common/         # Shared utilities
│       │   │   ├── config/     # Config service (reads DB + env)
│       │   │   ├── guards/     # Auth guards
│       │   │   ├── interceptors/ # Logging, transform
│       │   │   └── filters/    # Error handling
│       │   └── database/
│       │       ├── migrations/ # Versioned SQL migrations
│       │       └── seeds/      # Dev + test seed data
├── packages/
│   └── shared/                 # Types shared between apps
├── docker-compose.yml
├── .env.example
└── Makefile
```

---

## Database Schema Patterns

### Config Table (replaces all hardcoded values)
```sql
CREATE TABLE app_config (
  key         VARCHAR(255) PRIMARY KEY,
  value       TEXT NOT NULL,
  value_type  VARCHAR(50) NOT NULL DEFAULT 'string', -- string|number|boolean|json
  description TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by  UUID REFERENCES users(id)
);

-- Examples:
INSERT INTO app_config VALUES
  ('max_upload_size_mb', '50', 'number', 'Max file upload size in MB'),
  ('support_email', 'support@example.com', 'string', 'Support contact email'),
  ('maintenance_mode', 'false', 'boolean', 'Disable all writes when true');
```

### Feature Flags Table
```sql
CREATE TABLE feature_flags (
  flag              VARCHAR(255) PRIMARY KEY,
  enabled           BOOLEAN NOT NULL DEFAULT false,
  rollout_pct       INTEGER NOT NULL DEFAULT 0 CHECK (rollout_pct BETWEEN 0 AND 100),
  allowed_user_ids  UUID[] DEFAULT '{}',
  description       TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### Audit Log Table
```sql
CREATE TABLE audit_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES users(id),
  action      VARCHAR(255) NOT NULL,
  entity_type VARCHAR(255) NOT NULL,
  entity_id   TEXT,
  old_value   JSONB,
  new_value   JSONB,
  ip_address  INET,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX audit_log_user_created ON audit_log(user_id, created_at DESC);
CREATE INDEX audit_log_entity ON audit_log(entity_type, entity_id);
```

---

## Config Service Pattern

```typescript
// src/common/config/config.service.ts
@Injectable()
export class ConfigService {
  private cache = new Map<string, { value: any; expires: number }>();
  private TTL = 60_000; // 1 minute cache

  constructor(private db: DatabaseService) {}

  async get<T = string>(key: string, fallback?: T): Promise<T> {
    const cached = this.cache.get(key);
    if (cached && Date.now() < cached.expires) return cached.value as T;

    const row = await this.db.query(
      'SELECT value, value_type FROM app_config WHERE key = $1', [key]
    );
    if (!row) {
      if (fallback !== undefined) return fallback;
      throw new Error(`Config key not found: ${key}`);
    }

    const parsed = this.parse(row.value, row.value_type);
    this.cache.set(key, { value: parsed, expires: Date.now() + this.TTL });
    return parsed as T;
  }

  private parse(value: string, type: string): any {
    switch (type) {
      case 'number': return Number(value);
      case 'boolean': return value === 'true';
      case 'json': return JSON.parse(value);
      default: return value;
    }
  }
}
```

---

## API Response Envelope
```typescript
// Always return structured responses — never raw data
interface ApiResponse<T> {
  data: T | null;
  error: { code: string; message: string; details?: unknown } | null;
  meta?: { page?: number; total?: number; took_ms: number };
}
```

---

## Request Lifecycle

```
Request
  → Rate Limiter (Redis sliding window)
  → Auth Guard (validate JWT, load user)
  → Input Validation (Zod schema at controller)
  → Service Layer (business logic, no I/O knowledge)
  → Repository Layer (all DB access)
  → Response Interceptor (envelope + timing)
  → Structured Logger (correlation ID, duration, status)
```
