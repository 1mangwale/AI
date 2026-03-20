# Gap Analysis — Taxonomy, Scoring & Improvement Patterns

## The Scoring System (used in every IMPROVE phase)

| Score | Meaning | Example |
|-------|---------|---------|
| **1** | Not present / broken | No config table, no tests, no logs |
| **2** | Started, major gaps | Has auth but no input validation or rate limiting |
| **3** | Functional, not production-ready | Works happy path, would fail under real load |
| **4** | Production-ready — could ship | Handles real load, real failures, real edge cases |
| **5** | Exemplary — sets the standard | Nothing left to improve here |

**Score honestly. Never inflate. A 3 is not failure — it is accurate.**

Target: all 17 dimensions at 4+ before declaring done.
Pick the lowest-scoring dimension. That is always the next iteration target.

---

## The 17 Dimensions — Signs of Gaps + Fix Patterns

### 1. Architecture Correctness
**Signs of gaps:** Business logic in controllers, direct DB calls from UI, fat models,
circular dependencies, no bounded contexts, shared mutable state.
**Fix:** Layered architecture (controller → service → repository → DB). DDD for complex
domains. CQRS for high-read systems. Event sourcing for audit-critical flows.

### 2. Database-Driven Config
**Signs of gaps:** Hardcoded URLs, prices, limits in source code.
`if (env === 'production')` in business logic. Feature flags as `const ENABLE_X = true`.
**Fix:** `app_config` table. `feature_flags` table. Config service with TTL cache.
All business-logic values editable from DB without a code deploy.

### 3. Business Model Alignment
**Signs of gaps:** Code builds features with no connection to how the product makes money.
No plan enforcement. No usage metering. No billing hooks.
**Fix:** `plans`, `subscriptions`, `usage_events` tables. Plan enforcement middleware.
Every feature gated by plan.features[key] from DB. See `missing-pieces.md` → Monetisation.

### 4. Competitor Differentiation
**Signs of gaps:** Building something that already exists exactly as built elsewhere.
No identified white space. No unique architectural choice that reflects the product edge.
**Fix:** Market Map showing competitor gaps. Architecture decision that targets white space.
See `market-research.md` for research protocol.

### 5. UX Ergonomics (Research-Backed)
**Signs of gaps:** Components placed by aesthetic preference, not data.
No F/Z-pattern consideration. Touch targets too small. No accessibility baseline.
**Fix:** Apply placement rules from `ux-ergonomics.md`. WCAG AA contrast minimum.
44px touch targets. Label-above-field on all forms.

### 6. Diagrams & Wireframes Shown
**Signs of gaps:** Code written before the human has seen the data flow or screen layout.
Architecture exists only in Claude's head.
**Fix:** Data flow diagram (Mermaid) + wireframes (ASCII → visual) before every new feature.
See `diagrams-wireframes.md`.

### 7. Voice Integration (where applicable)
**When to apply:** Consumer apps, accessibility-critical products, hands-free use cases.
**When to skip:** B2B dashboards, developer tools, admin panels, API-only products.
**Signs of gaps (when applicable):** Text-only input where voice would improve UX.
**Fix:** STT (Whisper OSS) + TTS (Coqui OSS) adapter. Same service layer as text.
Voice config in DB. See `voice-integration.md`.
**Score 5 if:** Voice not applicable AND explicitly noted as "N/A — [reason]"

### 8. Scalability / Future-Proof
**Signs of gaps:** No caching, sync where async would do, no pagination, N+1 queries,
no connection pooling, hardcoded scale limits, vendor lock-in.
**Fix:** Redis caching at all layers. Async queue for non-blocking work. Cursor pagination.
All vendor APIs wrapped in swappable adapters. See `missing-pieces.md` → Caching.

### 9. Multi-Tenancy / Data Isolation
**Signs of gaps:** Single-tenant schema for a B2B product. No tenant_id on tables.
No row-level security. One user can see another's data with a crafted query.
**Fix:** Choose model (row-level / schema / DB-per-tenant). Implement RLS policies.
Tenant middleware sets DB session variable. See `missing-pieces.md` → Multi-Tenancy.

### 10. Cost Awareness
**Signs of gaps:** Paid APIs called without budget limits. No cost tracking.
System could rack up $10k/month without any alert.
**Fix:** `api_cost_log` table. `cost_budgets` table. Budget check before every external
paid API call. See `missing-pieces.md` → Cost Awareness.

### 11. LLM Integration (where applicable)
**Signs of gaps:** Prompts hardcoded in source files. No prompt versioning.
No cost tracking for tokens. No streaming on user-facing calls. No fallback model.
**Fix:** `ai_prompts` table with versioning. Prompt loaded from DB at runtime.
Token cost logged. Streaming default. Fallback model in DB config.
See `missing-pieces.md` → LLM Integration.

### 12. Transparency / Auditability
**Signs of gaps:** System takes actions with no record. Users can't see what happened.
No audit trail for compliance.
**Fix:** `system_actions` table recording every non-trivial system action.
Human-readable activity feed for users. ADR file for architecture decisions.

### 13. Security + Threat Model
**Signs of gaps:** No input validation at boundaries. SQL concatenation. Secrets in code.
No rate limiting. CORS `*`. No HTTPS enforcement. No threat model done.
**Fix:** STRIDE analysis for auth/payments/PII features. Zod/Pydantic at every boundary.
Secrets in vault. Rate limiting at gateway + per-endpoint.
Dependency audit in CI. See `missing-pieces.md` → Threat Modelling.

### 14. Observability
**Signs of gaps:** `console.log` instead of structured logging. No request IDs.
No metrics. No health check endpoints.
**Fix:** Structured JSON logs with `correlation_id`, `user_id`, `service`, `level`.
OpenTelemetry traces. Prometheus metrics. `/health` + `/ready` endpoints.

### 15. Test Coverage + Verification
**Signs of gaps:** No tests. Only happy-path tests. No verification checklist.
Code shipped without any validation it works.
**Fix:** Unit → integration → E2E → contract tests. Verification checklist with
every code block. See `testing-verification.md` for working templates.

### 16. DevOps / CI-CD
**Signs of gaps:** Manual deploys. No CI. No `docker-compose.yml`. `.env` committed.
DB migrations run by hand. No `Makefile`.
**Fix:** `docker-compose.yml` for local. `.github/workflows/ci.yml` for every push.
Migrations in CI before deploy. `.env.example` documented. `make setup/dev/test/deploy`.

### 17. Open-Source Preference + Tech Currency
**Signs of gaps:** Proprietary tools chosen without justification. Outdated versions used.
Deprecated APIs in use. Better OSS alternatives ignored.
**Fix:** Check versions + breaking changes before writing code. Prefer OSS.
Document any proprietary choice with explicit reason.

---

## Hardcoded Anti-Patterns — Hunt and Eliminate

Search the codebase for these and move to DB/config:

```
STRINGS:      "http://", "https://"  → app_config table
              "admin@", "noreply@"   → app_config table
              API keys, secrets      → vault (never source code)

NUMBERS:      timeout values         → app_config table
              retry counts           → app_config table
              pagination limits      → app_config table
              rate limit thresholds  → app_config table
              pricing, costs         → DB (plans table)

LOGIC:        if (userId === 'specific-id')         → remove entirely
              if (NODE_ENV === 'production')          → feature flag in DB
              const FEATURE_ENABLED = true/false     → feature_flags table
```
