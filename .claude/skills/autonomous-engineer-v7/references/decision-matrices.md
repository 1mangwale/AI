# Decision Matrices — When to Use What

## The Rule
**Never pick tech because it's popular. Pick based on constraints.**

---

## 1. Architecture Pattern

```
START
  │
  ├─ Team size < 5 AND users < 100k?
  │   └─ YES → MODULAR MONOLITH
  │            (single deploy, clean modules, can split later)
  │
  ├─ Need independent scaling per feature?
  │   └─ YES → MICROSERVICES
  │            (but only if you have DevOps capacity)
  │
  ├─ Complex domain with many business rules?
  │   └─ YES → DOMAIN-DRIVEN DESIGN (DDD)
  │            (bounded contexts, aggregates, events)
  │
  ├─ Need audit trail of all changes?
  │   └─ YES → EVENT SOURCING
  │            (store events, rebuild state)
  │
  ├─ Read/write patterns very different?
  │   └─ YES → CQRS
  │            (separate read/write models)
  │
  └─ DEFAULT → CLEAN ARCHITECTURE
               (layers: domain → application → infrastructure)
```

### Quick Reference

| Pattern | Use When | Avoid When |
|---------|----------|------------|
| Modular Monolith | Starting out, small team | Need independent deploys |
| Microservices | Team > 10, need isolation | Small team, simple domain |
| DDD | Complex business logic | CRUD app, simple domain |
| Event Sourcing | Need full audit, time travel | Simple state, no audit needs |
| CQRS | Heavy reads, light writes | Read/write similar |
| Clean Architecture | Most apps (default) | Prototype/MVP |

---

## 2. Database Selection

```
START
  │
  ├─ Relational data? (users, orders, invoices)
  │   └─ YES → POSTGRESQL (always)
  │
  ├─ Document/flexible schema?
  │   ├─ Need transactions? → PostgreSQL JSONB
  │   └─ No transactions? → MongoDB
  │
  ├─ Time-series? (metrics, logs, IoT)
  │   └─ YES → TimescaleDB (PostgreSQL extension)
  │
  ├─ Graph relationships? (social, recommendations)
  │   └─ YES → Neo4j or PostgreSQL + recursive CTEs
  │
  ├─ Full-text search?
  │   ├─ Simple? → PostgreSQL FTS
  │   └─ Complex? → Elasticsearch / Meilisearch
  │
  ├─ Vector/embeddings? (AI, semantic search)
  │   └─ YES → pgvector (PostgreSQL extension)
  │
  ├─ Cache/sessions?
  │   └─ YES → Redis
  │
  └─ DEFAULT → PostgreSQL
```

### Quick Reference

| Need | Best Choice | Why |
|------|-------------|-----|
| General purpose | PostgreSQL | ACID, JSON, FTS, vectors, extensions |
| Documents | PostgreSQL JSONB or MongoDB | Depends on transaction needs |
| Cache | Redis | Speed, pub/sub, data structures |
| Search | Meilisearch | Easy setup, typo tolerance |
| Vectors | pgvector | Stays in PostgreSQL |
| Time-series | TimescaleDB | PostgreSQL-native |

---

## 3. API Protocol

```
START
  │
  ├─ Public API for third parties?
  │   └─ YES → REST + OpenAPI
  │            (universal, documented, cacheable)
  │
  ├─ Internal services?
  │   ├─ Same language? → tRPC (if TypeScript)
  │   └─ Different languages? → gRPC
  │
  ├─ Complex queries, multiple resources?
  │   └─ YES → GraphQL
  │            (but beware N+1, complexity)
  │
  ├─ Real-time bidirectional?
  │   └─ YES → WebSocket or Server-Sent Events
  │
  ├─ High performance, low latency?
  │   └─ YES → gRPC (binary, HTTP/2)
  │
  └─ DEFAULT → REST
```

### Quick Reference

| Protocol | Use When | Avoid When |
|----------|----------|------------|
| REST | Public APIs, simple CRUD | Complex nested queries |
| GraphQL | Multiple clients, flexible queries | Simple APIs, small team |
| gRPC | Internal services, performance | Public APIs, browser clients |
| tRPC | TypeScript full-stack, internal | Multiple languages |
| WebSocket | Chat, live updates, gaming | Request-response only |
| SSE | One-way streaming (notifications) | Bidirectional needed |

---

## 4. Frontend Rendering

```
START
  │
  ├─ SEO critical? (blog, e-commerce, landing)
  │   └─ YES → SSR or SSG
  │            Next.js / Astro
  │
  ├─ Highly interactive? (dashboard, app)
  │   └─ YES → SPA or SSR with hydration
  │            React / Vue / Svelte
  │
  ├─ Content-heavy, rarely changes?
  │   └─ YES → SSG (Static Site Generation)
  │            Astro / Next.js static
  │
  ├─ Mix of static + dynamic?
  │   └─ YES → ISR (Incremental Static Regen)
  │            Next.js ISR
  │
  └─ DEFAULT → SSR (Next.js)
```

### Quick Reference

| Strategy | Use When | Tradeoff |
|----------|----------|----------|
| SSR | SEO + dynamic content | Server load |
| SSG | Content rarely changes | Rebuild on change |
| ISR | Mix of both | Complexity |
| SPA | App-like, no SEO needs | No SEO, slow first load |
| Hybrid | Different pages need different | More complex |

---

## 5. State Management

```
START
  │
  ├─ Server state? (API data)
  │   └─ YES → React Query / SWR / tRPC
  │            (cache, refetch, optimistic updates)
  │
  ├─ Simple client state?
  │   └─ YES → useState / useReducer
  │            (React built-in)
  │
  ├─ Shared across components?
  │   ├─ Small app? → Context + useReducer
  │   └─ Large app? → Zustand (simple) or Jotai (atomic)
  │
  ├─ Complex with time-travel/devtools?
  │   └─ YES → Redux Toolkit
  │            (but rarely needed now)
  │
  └─ DEFAULT → React Query + Zustand
```

### Quick Reference

| Library | Use When | Complexity |
|---------|----------|------------|
| React Query | Server state, caching | Low |
| Zustand | Client state, simple API | Low |
| Jotai | Atomic state, derived values | Medium |
| Redux Toolkit | Complex, time-travel needed | High |
| Context | Small app, prop drilling fix | Low |

---

## 6. Authentication

```
START
  │
  ├─ Third-party login? (Google, GitHub)
  │   └─ YES → OAuth 2.0 + OIDC
  │            (use a provider: Auth0, Clerk, NextAuth)
  │
  ├─ API for mobile + web?
  │   └─ YES → JWT (short-lived) + Refresh Token
  │            (store refresh in httpOnly cookie)
  │
  ├─ Web only, simple?
  │   └─ YES → Session cookies
  │            (httpOnly, secure, sameSite)
  │
  ├─ Machine-to-machine?
  │   └─ YES → API Keys or OAuth Client Credentials
  │
  └─ DEFAULT → Session cookies (web) or JWT (API)
```

### Quick Reference

| Method | Use When | Security Level |
|--------|----------|----------------|
| Session cookie | Web-only, simple | High (httpOnly) |
| JWT + Refresh | Multi-platform (web + mobile) | Medium-High |
| OAuth/OIDC | Social login, enterprise SSO | Depends on provider |
| API Keys | Server-to-server, simple | Low (rotate often) |
| Passkeys/WebAuthn | Passwordless (2024+ trend) | Very High |

---

## 7. Hosting / Deployment

```
START
  │
  ├─ Frontend only?
  │   └─ YES → Vercel / Netlify / Cloudflare Pages
  │
  ├─ Full-stack, simple?
  │   └─ YES → Vercel (if Next.js) or Railway
  │
  ├─ Need containers?
  │   └─ YES → Railway / Render / Fly.io
  │
  ├─ Need full control?
  │   └─ YES → AWS / GCP / DigitalOcean
  │            (but manage yourself)
  │
  ├─ Budget tight?
  │   └─ YES → Railway / Render / Fly.io
  │            (free tiers, pay as grow)
  │
  └─ DEFAULT → Vercel (frontend) + Railway (backend)
```

### Quick Reference

| Platform | Best For | Pricing |
|----------|----------|---------|
| Vercel | Next.js, frontend | Free → $20/mo |
| Railway | Backend, databases | Free → usage |
| Render | Full-stack, simple | Free → $7/mo |
| Fly.io | Global edge, containers | Free → usage |
| Supabase | PostgreSQL + Auth + Storage | Free → $25/mo |

---

## 8. Caching Strategy

```
START
  │
  ├─ Static assets? (images, CSS, JS)
  │   └─ YES → CDN (Cloudflare, Vercel Edge)
  │
  ├─ Database queries?
  │   └─ YES → Redis (query results, 5-60min TTL)
  │
  ├─ Session data?
  │   └─ YES → Redis (fast, shared across instances)
  │
  ├─ API responses?
  │   ├─ Rarely changes? → HTTP cache headers
  │   └─ User-specific? → Redis or in-memory
  │
  ├─ Computed values?
  │   └─ YES → Memoization + Redis
  │
  └─ DEFAULT → CDN + Redis
```

### Cache Invalidation Rules

```
1. Time-based (TTL): Good for config, slow-changing data
2. Event-based: Good for user actions (invalidate on write)
3. Version-based: Good for deployments (bust all caches)

RULE: If you can't invalidate it reliably, use short TTL.
```

---

## 9. Sync vs Async

```
START
  │
  ├─ User waiting for response?
  │   └─ YES → SYNC (but timeout < 30s)
  │
  ├─ Can fail and retry later?
  │   └─ YES → ASYNC (queue: BullMQ, SQS)
  │
  ├─ Takes > 30 seconds?
  │   └─ YES → ASYNC + webhook/polling
  │
  ├─ Multiple services involved?
  │   └─ YES → ASYNC (event-driven)
  │
  ├─ Needs guaranteed delivery?
  │   └─ YES → Message queue (RabbitMQ, SQS)
  │
  └─ DEFAULT → SYNC for reads, ASYNC for heavy writes
```

### Quick Reference

| Pattern | Use When | Tool |
|---------|----------|------|
| Sync | Fast, user waiting | HTTP request |
| Queue | Background jobs, retries | BullMQ, SQS |
| Events | Decoupled services | Kafka, Redis Pub/Sub |
| Webhooks | Notify external systems | HTTP POST |
| Polling | Simple, low-frequency | setInterval |

---

## 10. Testing Strategy

```
START
  │
  ├─ Pure logic? (no I/O)
  │   └─ UNIT TEST (Jest, pytest)
  │
  ├─ Database interaction?
  │   └─ INTEGRATION TEST (Testcontainers)
  │
  ├─ API endpoint?
  │   └─ API TEST (Supertest, httpx)
  │
  ├─ User journey?
  │   └─ E2E TEST (Playwright)
  │
  ├─ Performance?
  │   └─ LOAD TEST (k6)
  │
  └─ DEFAULT → All of the above, weighted
```

### Coverage Targets

| Layer | Target | Priority |
|-------|--------|----------|
| Unit (logic) | 80%+ | High |
| Integration | Critical paths | High |
| API | Every endpoint | High |
| E2E | Happy paths | Medium |
| Performance | Before launch | Medium |

---

## Decision Checklist (Before Starting)

```
□ Architecture pattern chosen? (monolith/micro/DDD)
□ Database selected? (usually PostgreSQL)
□ API protocol decided? (REST/GraphQL/gRPC)
□ Rendering strategy? (SSR/SSG/SPA)
□ Auth approach? (session/JWT/OAuth)
□ Hosting platform? (Vercel/Railway/etc)
□ Caching strategy? (CDN/Redis/both)
□ Testing strategy? (pyramid levels)
□ Async vs sync for each feature?
□ State management approach?
```

**Document every decision in `.claude/DECISIONS.md` with WHY.**
