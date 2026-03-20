# Missing Pieces — Cost, Multi-Tenancy, Caching, LLM, Monetisation, i18n, Security

## Table of Contents

1. [Cost Awareness](#1-cost-awareness) — infra costs, API cost tracking, budget enforcement
2. [Multi-Tenancy Patterns](#2-multi-tenancy-patterns) — row-level, schema, DB-per-tenant
3. [Caching Strategy](#3-caching-strategy--all-layers) — browser → CDN → gateway → app → DB
4. [LLM Integration Patterns](#4-llm-integration-patterns) — RAG, prompt versioning, cost control
5. [Monetisation Patterns](#5-monetisation-patterns-code-level) — plans, subscriptions, plan enforcement
6. [Internationalisation](#6-internationalisation-i18n) — i18n, locale, timezone, RTL
7. [Threat Modelling & Security](#7-threat-modelling-stride) — STRIDE, dependency audit, Dependabot

---


## 1. Cost Awareness

Before recommending any paid service or architecture, estimate the running cost.
A beautiful system that costs $10,000/month for 100 users is not production-ready.

### Infrastructure Cost Estimation (monthly, rough order of magnitude)

| Service | Free tier | $50/mo gets you | $500/mo gets you |
|---------|-----------|-----------------|------------------|
| Railway | 512MB RAM | 1 service, 1GB RAM | 4 services, 8GB RAM |
| Render | Static + 750h | 1 web service | 4 services + DB |
| Supabase | 500MB DB | 8GB DB + auth | 100GB + realtime |
| Vercel | 100GB bandwidth | Pro bandwidth | Team features |
| AWS EC2 | t3.micro 750h | t3.small always-on | t3.medium + RDS |
| OpenAI GPT-4o | $0 | ~2M tokens | ~20M tokens |
| Twilio SMS | Trial | ~500 SMS/mo | ~5000 SMS/mo |
| ElevenLabs TTS | 10k chars | 30k chars | 500k chars |

### Cost DB Table (mandatory for any paid service used)

```sql
-- Track every API call cost in real time
CREATE TABLE api_cost_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service      VARCHAR(100) NOT NULL,  -- 'openai', 'twilio', 'elevenlabs'
  operation    VARCHAR(100) NOT NULL,  -- 'chat.completion', 'sms.send'
  user_id      UUID REFERENCES users(id),
  units        DECIMAL(10,4),          -- tokens, characters, messages
  unit_cost    DECIMAL(10,8),          -- cost per unit in USD
  total_cost   DECIMAL(10,6),          -- units * unit_cost
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Monthly budget alerts
CREATE TABLE cost_budgets (
  service      VARCHAR(100) PRIMARY KEY,
  monthly_limit_usd DECIMAL(10,2) NOT NULL,
  alert_at_pct INTEGER NOT NULL DEFAULT 80,  -- alert at 80% of budget
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);
```

### Cost Check Before Every External API Call

```typescript
async function checkCostBudget(service: string, estimatedCost: number): Promise<void> {
  const { monthly_limit_usd, alert_at_pct } = await configService.get(`cost_budget.${service}`);
  const monthlySpend = await costRepo.getMonthlyTotal(service);
  const projectedTotal = monthlySpend + estimatedCost;
  
  if (projectedTotal > monthly_limit_usd) {
    throw new BudgetExceededError(`${service} monthly budget exceeded`);
  }
  if (projectedTotal / monthly_limit_usd > alert_at_pct / 100) {
    await notificationService.alert(`${service} at ${Math.round(projectedTotal/monthly_limit_usd*100)}% of budget`);
  }
}
```

---

## 2. Multi-Tenancy Patterns

For any B2B or SaaS product, choose one model before writing any schema.

### Three Models

```
MODEL A: Row-level (shared DB, tenant_id column)
  GOOD: Simple, cheap, easy to start
  BAD:  Risk of data leak if query misses tenant_id filter
  USE:  Early stage, <100 tenants, low compliance requirements

MODEL B: Schema-per-tenant (shared DB, separate schemas)
  GOOD: Strong isolation, easy backup per tenant
  BAD:  Schema migration complexity (run per-tenant)
  USE:  Mid-stage, 100–10k tenants, some compliance needs

MODEL C: DB-per-tenant (separate databases)
  GOOD: Maximum isolation, custom retention per tenant
  BAD:  Expensive, complex connection pooling
  USE:  Enterprise, HIPAA/GDPR strict, <100 large tenants
```

### Row-Level Pattern (default for new SaaS)

```sql
-- Every table has tenant_id. Row Level Security enforces it.
CREATE TABLE orders (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES tenants(id),
  -- ... other fields
);

-- Enable RLS
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

-- Policy: can only see own tenant's rows
CREATE POLICY orders_tenant_isolation ON orders
  USING (tenant_id = current_setting('app.tenant_id')::UUID);
```

```typescript
// Middleware: set tenant context on every request
async function tenantMiddleware(req, res, next) {
  const tenantId = req.user?.tenantId;
  if (!tenantId) return res.status(401).json({ error: 'No tenant context' });
  
  // Set Postgres session variable — RLS uses this
  await db.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
  next();
}
```

### Tenant Config (per-tenant feature flags + limits)

```sql
CREATE TABLE tenant_config (
  tenant_id   UUID REFERENCES tenants(id),
  key         VARCHAR(255),
  value       TEXT,
  PRIMARY KEY (tenant_id, key)
);

-- Examples: per-tenant limits, features, branding
INSERT INTO tenant_config VALUES
  ('tenant-1', 'max_users', '50'),
  ('tenant-1', 'feature.ai_enabled', 'true'),
  ('tenant-1', 'branding.primary_color', '#FF6B35');
```

---

## 3. Caching Strategy — All Layers

```
BROWSER CACHE      → static assets, API responses with Cache-Control headers
       ↓
CDN EDGE CACHE     → Cloudflare/Vercel Edge — public pages, images
       ↓
API GATEWAY CACHE  → repeated identical API requests (same params, same user)
       ↓
APPLICATION CACHE  → Redis — computed results, DB query results
       ↓
DATABASE           → query plan cache, connection pool
```

### Redis Cache Patterns

```typescript
// Pattern 1: Cache-aside (most common)
async function getUser(userId: string): Promise<User> {
  const cached = await redis.get(`user:${userId}`);
  if (cached) return JSON.parse(cached);
  
  const user = await userRepo.findById(userId);
  await redis.setex(`user:${userId}`, 300, JSON.stringify(user)); // 5 min TTL
  return user;
}

// Pattern 2: Cache invalidation on write
async function updateUser(userId: string, data: UpdateUserDto): Promise<User> {
  const updated = await userRepo.update(userId, data);
  await redis.del(`user:${userId}`);  // invalidate immediately
  return updated;
}

// Pattern 3: Cache stampede prevention (mutex)
async function getExpensiveData(key: string): Promise<Data> {
  const cached = await redis.get(key);
  if (cached) return JSON.parse(cached);
  
  // Acquire lock — only one request recomputes
  const lock = await redis.set(`lock:${key}`, '1', 'NX', 'EX', 10);
  if (!lock) {
    // Wait and retry — another request is computing it
    await sleep(100);
    return getExpensiveData(key);
  }
  
  const data = await computeExpensiveData(key);
  await redis.setex(key, 600, JSON.stringify(data));
  await redis.del(`lock:${key}`);
  return data;
}
```

### Cache TTL Strategy

```typescript
// TTL by data volatility — store in DB config, not hardcoded
const CACHE_TTLS = {
  'user_profile':     300,    // 5 min — changes occasionally
  'user_settings':    60,     // 1 min — changes more often
  'product_catalog':  3600,   // 1 hour — stable
  'pricing':          1800,   // 30 min — semi-stable
  'feature_flags':    60,     // 1 min — needs to propagate fast
  'search_results':   120,    // 2 min — balance freshness vs speed
  'dashboard_stats':  30,     // 30 sec — near-real-time feel
};
```

---

## 4. LLM Integration Patterns

Every modern product has AI. Build it right from the start.

### Core Principles
- All prompts versioned in DB (not hardcoded in code)
- All LLM calls logged with cost
- Streaming by default for user-facing calls
- Fallback model if primary is down
- Rate limiting per user per day

### Prompt Versioning in DB (mandatory)

```sql
CREATE TABLE ai_prompts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(255) NOT NULL,    -- 'order_summary', 'chat_system'
  version     INTEGER NOT NULL,
  content     TEXT NOT NULL,
  model       VARCHAR(100) NOT NULL,    -- 'claude-sonnet-4-6', 'gpt-4o'
  is_active   BOOLEAN DEFAULT false,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(name, version)
);

-- Only one active version per prompt name
CREATE UNIQUE INDEX ai_prompts_active ON ai_prompts(name) WHERE is_active = true;
```

### RAG Pattern (Retrieval-Augmented Generation)

```typescript
// src/modules/ai/rag.service.ts
export class RAGService {
  async query(userQuestion: string, userId: string): Promise<string> {
    // 1. Embed the question
    const embedding = await this.embedder.embed(userQuestion);
    
    // 2. Find relevant documents from vector store
    const relevantDocs = await this.vectorStore.search(embedding, {
      limit: 5,
      filter: { userId },   // scoped to user's data
    });
    
    // 3. Build context from docs
    const context = relevantDocs.map(d => d.content).join('\n\n');
    
    // 4. Get prompt from DB (versioned, not hardcoded)
    const prompt = await this.promptRepo.getActive('rag_query');
    
    // 5. Call LLM with context + question
    const response = await this.llm.complete({
      system: prompt.content.replace('{{context}}', context),
      user: userQuestion,
      model: prompt.model,
      stream: true,    // always stream for user-facing
    });
    
    // 6. Log cost
    await this.costLogger.log('openai', 'chat.completion', response.usage);
    
    return response.text;
  }
}
```

### LLM Rate Limiting + Fallback

```typescript
// src/infra/llm/llm-client.ts
export class LLMClient {
  async complete(params: LLMParams): Promise<LLMResponse> {
    // Check user's daily token budget (from DB config)
    await this.budgetService.check(params.userId, 'tokens_per_day');
    
    // Primary model with timeout
    try {
      return await Promise.race([
        this.callPrimary(params),
        timeout(10_000, 'LLM primary timeout'),
      ]);
    } catch (err) {
      // Fallback to cheaper/faster model
      const fallback = await configService.get('llm.fallback_model');
      return this.callModel(fallback, params);
    }
  }
}
```

---

## 5. Monetisation Patterns (Code Level)

### DB Schema for Billing

```sql
CREATE TABLE plans (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(100) NOT NULL,  -- 'free', 'pro', 'enterprise'
  price_cents   INTEGER NOT NULL,
  billing_cycle VARCHAR(20) NOT NULL,   -- 'monthly', 'annual'
  features      JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE subscriptions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID REFERENCES tenants(id),
  plan_id         UUID REFERENCES plans(id),
  status          VARCHAR(50) NOT NULL,   -- 'active', 'cancelled', 'past_due'
  current_period_end TIMESTAMPTZ NOT NULL,
  stripe_sub_id   VARCHAR(255),           -- external reference
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE usage_events (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID REFERENCES tenants(id),
  event_type VARCHAR(100) NOT NULL,   -- 'api_call', 'ai_query', 'export'
  quantity   INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Plan Enforcement Middleware

```typescript
// Enforce plan limits on every feature — limits come from DB, not code
async function planEnforcement(feature: string) {
  return async (req, res, next) => {
    const plan = await subscriptionService.getPlan(req.tenant.id);
    const limit = plan.features[feature];
    
    if (limit === false) {
      return res.status(402).json({
        error: { code: 'PLAN_LIMIT', message: `${feature} requires a higher plan` }
      });
    }
    if (typeof limit === 'number') {
      const usage = await usageService.getMonthly(req.tenant.id, feature);
      if (usage >= limit) {
        return res.status(402).json({
          error: { code: 'USAGE_LIMIT', message: `${feature} limit of ${limit} reached` }
        });
      }
    }
    next();
  };
}
```

---

## 6. Internationalisation (i18n)

### Non-negotiable rules
- All user-facing strings in translation files, never hardcoded
- Dates/times displayed in user's timezone (stored as UTC)
- Numbers formatted per locale (1,000.00 vs 1.000,00)
- RTL layout supported from day one if any RTL language planned

### Implementation

```typescript
// All strings in DB or translation files — never in code
// DB approach (dynamic, admin-editable)
CREATE TABLE translations (
  key      VARCHAR(255) NOT NULL,
  locale   VARCHAR(10) NOT NULL,   -- 'en', 'hi', 'ar', 'zh'
  value    TEXT NOT NULL,
  PRIMARY KEY (key, locale)
);

// Locale stored per user
ALTER TABLE users ADD COLUMN locale VARCHAR(10) NOT NULL DEFAULT 'en';
ALTER TABLE users ADD COLUMN timezone VARCHAR(100) NOT NULL DEFAULT 'UTC';

// Date display: always store UTC, display in user timezone
function formatDate(utcDate: Date, userTimezone: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: userTimezone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(utcDate);
}
```

---

## 7. Threat Modelling (STRIDE)

Run this before building any auth, payments, or user data feature.

### STRIDE per feature

For each new feature, fill this out:

| Threat | Question | Mitigation |
|--------|----------|-----------|
| **S**poofing | Can someone pretend to be another user? | JWT with short expiry + refresh rotation |
| **T**ampering | Can someone modify data in transit or at rest? | HTTPS everywhere, signed webhooks, DB encryption |
| **R**epudiation | Can users deny actions they took? | Audit log for every mutation |
| **I**nfo disclosure | Can someone read data they shouldn't? | RLS policies, field-level auth, no PII in logs |
| **D**oS | Can someone make the service unavailable? | Rate limiting, input size limits, query timeouts |
| **E**levation | Can someone get admin access? | RBAC, principle of least privilege, MFA for admins |

### Dependency Audit in CI

```yaml
# .github/workflows/security.yml
- name: Audit dependencies
  run: npm audit --audit-level=high

- name: Scan with Snyk
  uses: snyk/actions/node@master
  env:
    SNYK_TOKEN: ${{ secrets.SNYK_TOKEN }}

- name: Check for secrets in code
  uses: trufflesecurity/trufflehog@main
  with:
    path: ./
    base: main
    head: HEAD
```

Add Dependabot:
```yaml
# .github/dependabot.yml
updates:
  - package-ecosystem: npm
    directory: /
    schedule: { interval: weekly }
    open-pull-requests-limit: 5
```
