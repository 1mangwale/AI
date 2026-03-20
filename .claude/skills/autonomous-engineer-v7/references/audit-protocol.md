# Audit Protocol — Deep Understanding Before Code

## Golden Rule

**Never write code until you can fill every section of the audit file.**

---

## Audit Types

### 1. PROJECT_AUDIT.md (New Projects)

Use when starting fresh. Goal: understand what we're building.

```markdown
# Project Audit — [Name] — v1.0.0
Generated: [date]
Developer: Akash A Agarwal

## 1. Problem Statement
### What problem are we solving?
[Clear 1-2 sentence description]

### Why does this problem exist?
[Root cause]

### Why solve it now?
[Urgency/opportunity]

## 2. User Personas
### Primary User: [Name/Role]
- Demographics: [age, job, tech-savviness]
- Goals: [what they want to achieve]
- Pain points: [current frustrations]
- Context: [when/where they use this]

### Secondary User: [if any]
- ...

## 3. User Journeys (Prioritized)

### Journey 1: [Primary - e.g., "New user signup"]
**Trigger:** User wants to...
**Steps:**
1. User lands on [page] → sees [what]
2. User clicks [button] → system does [what]
3. User fills [form] → validation: [rules]
4. System creates [record] → shows [confirmation]
5. User receives [email/notification]

**Success criteria:** [how we know it worked]
**Edge cases:**
- What if email already exists? → [handling]
- What if validation fails? → [handling]
- What if system is slow? → [handling]

### Journey 2: [Secondary]
...

### Journey 3: [Tertiary]
...

## 4. Technical Decisions

### Stack
| Layer | Choice | Reason |
|-------|--------|--------|
| Frontend | Next.js 15 | SSR, App Router |
| Backend | NestJS | DI, TypeScript |
| Database | PostgreSQL | Relational, ACID |
| Cache | Redis | Sessions, queues |
| Hosting | Vercel + Railway | Easy deployment |

### Database Schema (Draft)
```sql
-- Core tables
users (id, email, password_hash, created_at)
[other tables...]
```

### API Endpoints (Draft)
```
POST /auth/register
POST /auth/login
GET  /users/me
[other endpoints...]
```

### Third-Party Integrations
| Service | Purpose | API Docs |
|---------|---------|----------|
| Stripe | Payments | [url] |
| SendGrid | Email | [url] |

## 5. Questions & Answers Log
| # | Question | Answer | Date |
|---|----------|--------|------|
| 1 | [question] | [answer] | [date] |
| 2 | [question] | [answer] | [date] |

## 6. Assumptions (Need Confirmation)
- [ ] User has email access
- [ ] Mobile-responsive required
- [ ] Dark mode optional
- [add more...]

## 7. Explicitly Out of Scope
- Admin panel (Phase 2)
- Mobile app (Phase 3)
- [other exclusions]

## 8. Task Breakdown
| # | Task | Priority | Estimate | Status | Branch |
|---|------|----------|----------|--------|--------|
| 1 | Project setup | P0 | 30min | pending | — |
| 2 | Auth module | P0 | 2hr | pending | — |
| 3 | User CRUD | P1 | 1hr | pending | — |

## 9. Risk Assessment
| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Scope creep | Medium | High | Strict out-of-scope |
| Tech issues | Low | Medium | Proven stack |

## 10. Version History
- v1.0.0 [date]: Initial audit created
- v1.1.0 [date]: Added [section] after clarification
```

---

### 2. CODEBASE_AUDIT.md (Existing Projects)

Use when modifying existing code. Goal: understand what exists before changing it.

```markdown
# Codebase Audit — [Name] — v1.0.0
Generated: [date]
Developer: Akash A Agarwal
Git HEAD: [commit hash]

## 1. Project Overview
- **Purpose:** [what this project does]
- **Age:** [when created, by whom]
- **Last updated:** [date]
- **Documentation:** [exists? quality?]

## 2. File Structure
```
[tree output - 2 levels deep]
```

## 3. Tech Stack Detected
| Component | Version | Notes |
|-----------|---------|-------|
| Runtime | Node 20 | |
| Framework | NestJS 10 | |
| Database | PostgreSQL 15 | Via Prisma |
| [etc...] | | |

### package.json Key Dependencies
```json
{
  "dependencies": {
    "[pkg]": "[version]" // [what it does]
  }
}
```

## 4. Architecture Analysis

### Pattern: [e.g., "Layered MVC"]
```
┌─────────────┐
│ Controllers │ ← HTTP layer
├─────────────┤
│  Services   │ ← Business logic
├─────────────┤
│   Repos     │ ← Data access
└─────────────┘
```

### Code Organization
- Entry point: `src/main.ts`
- Modules: `src/modules/[name]/`
- Shared: `src/common/`

## 5. Feature Map

### Feature: [e.g., "Authentication"]
**Files:**
- `src/auth/auth.module.ts`
- `src/auth/auth.service.ts`
- `src/auth/auth.controller.ts`

**Flow:**
1. Request hits `/auth/login`
2. Controller validates DTO
3. Service checks credentials
4. JWT returned

**Tests:** `src/auth/auth.spec.ts` — 12 tests, passing

**Known issues:**
- Token refresh not implemented
- Rate limiting missing

### Feature: [next feature]
...

## 6. Code Health Score

| Dimension | Score | Evidence |
|-----------|-------|----------|
| Structure | 4/5 | Clear separation |
| Naming | 3/5 | Some unclear vars |
| Types | 5/5 | Strict TypeScript |
| Tests | 2/5 | Only unit, no e2e |
| Docs | 2/5 | README only |
| Security | 3/5 | Basic auth, no rate limit |

**Overall:** 3.2/5 — Needs test coverage and docs

## 7. Database State
### Tables
| Table | Rows | Last Modified |
|-------|------|---------------|
| users | 1,234 | 2026-03-15 |
| orders | 5,678 | 2026-03-20 |

### Schema Issues Found
- [ ] No index on users.email
- [ ] orders.status is string, should be enum

## 8. Questions About Existing Code
| # | Question | File | Answer |
|---|----------|------|--------|
| 1 | Why raw SQL here? | orders.repo.ts:45 | [pending] |
| 2 | Is this dead code? | utils/legacy.ts | [pending] |

## 9. Change Impact Analysis

### Proposed Change: [description]

**Files to modify:**
- `src/[file].ts` — [what changes]
- `src/[file].ts` — [what changes]

**Files potentially affected:**
- `src/[file].ts` — uses modified function

**Risk level:** Medium

**Rollback strategy:**
```bash
git reset --hard [current HEAD hash]
```

## 10. Git Analysis
- **Total commits:** [N]
- **Contributors:** [list]
- **Branching strategy:** [GitFlow / trunk-based]
- **Last 5 commits:**
```
[hash] [message] [date]
```

## 11. Task Plan
| # | Task | Files | Risk | Status | Branch |
|---|------|-------|------|--------|--------|
| 1 | [task] | [files] | Low | pending | feat/task-1 |

## 12. Version History
- v1.0.0 [date]: Initial codebase audit
```

---

## Question Bank (By Category)

### User Understanding
```
1. Who is the primary user?
   A) Consumer (B2C)
   B) Business user (B2B)  
   C) Developer (API)
   D) Internal/Admin
   
2. What triggers them to use this?
   A) Daily routine
   B) Specific event
   C) Problem arises
   D) Someone told them
   
3. What's their tech comfort?
   A) Non-technical
   B) Tech-savvy consumer
   C) Developer
   D) Mixed audience
   
4. What device do they use?
   A) Desktop primarily
   B) Mobile primarily
   C) Both equally
   D) API/programmatic
```

### Journey Understanding
```
5. What's the happy path end state?
   A) Data saved
   B) Transaction complete
   C) Content consumed
   D) Action triggered
   
6. What can go wrong?
   [List all failure modes]
   
7. How should errors display?
   A) Toast notification
   B) Inline message
   C) Error page
   D) Silent retry
   
8. What happens after success?
   A) Redirect to [page]
   B) Show confirmation
   C) Trigger next step
   D) Nothing (async background)
```

### Technical Understanding
```
9. Is there existing code?
   A) No, fresh start
   B) Yes, I'll share it
   C) Yes, it's on GitHub
   D) Partial — some exists
   
10. Database preference?
    A) PostgreSQL
    B) MySQL
    C) MongoDB
    D) SQLite (simple/dev)
    E) Use existing
    
11. Auth requirements?
    A) Email/password
    B) Social login
    C) SSO/SAML
    D) API keys
    E) None needed
```

### Business Understanding
```
12. Revenue model?
    A) Subscription
    B) Transaction fee
    C) Usage-based
    D) Free / internal tool
    
13. Scale expectations (users)?
    A) <100 (MVP/internal)
    B) 100-10K (startup)
    C) 10K-1M (growth)
    D) 1M+ (scale)
    
14. Timeline?
    A) ASAP / prototype
    B) This week
    C) This month
    D) No rush
```

---

## When to Update Audit

| Event | Action |
|-------|--------|
| New requirement | Add to audit, bump version |
| Assumption confirmed | Mark checkbox |
| Scope changed | Update, note in version history |
| Question answered | Log in Q&A section |
| Task completed | Update status |
| Major learning | Add to "Lessons Learned" section |

---

## Audit Verification Checklist

Before writing ANY code:

```
□ I can explain the problem in one sentence
□ I know who the user is
□ I can walk through the primary journey step by step
□ I know what success looks like
□ I know what can go wrong
□ I know the tech stack
□ I know what's out of scope
□ I've documented all this in audit file
□ User has confirmed my understanding
□ Audit file is committed to git
```

If ANY checkbox is empty → Ask more questions.
