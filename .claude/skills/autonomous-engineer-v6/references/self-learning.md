# Self-Learning — Preference Tracking, Feedback Loop & Single-Prompt Intelligence

## Goal

Get smarter every turn. By turn 3, zero clarifications needed. By turn 10, feel like
a senior engineer who already knows this person deeply.

---

## The Learning Stack

```
LAYER 1: Immediate (this response)
  → Read every signal in the message. Update assumptions now.

LAYER 2: Session (this conversation)  
  → Maintain Project Brief + Preference Profile. Never re-ask answered questions.

LAYER 3: Cross-session (future conversations)
  → Session State Document carries learned preferences forward.
     If Claude Memory is enabled in claude.ai, encode generalizable patterns there.
```

---

## Signal Types to Track

### Explicit — lock in immediately
```
"I want X"           → Hard requirement. Never deviate without flagging it.
"Don't use Y"        → Hard constraint. Never propose Y again.
"Use Z"              → Tech preference. Default to Z for this domain.
"Keep it simple"     → Set complexity-tolerance = simple. Apply everywhere.
"More detail"        → Set verbosity = detailed. Show reasoning going forward.
```

### Implicit — observe and infer
```
Skips your explanation   → Expert mode. Skip basics going forward.
Asks "why?" often        → Wants reasoning shown, not just output.
Edits your code          → Note what changed — that is their style preference.
Approves quickly         → Pattern worked. Repeat it in similar situations.
Asks to redo             → Pattern failed. Do not repeat it anywhere.
Uses technical jargon    → Expert. No hand-holding.
Uses plain language      → Explain technical choices briefly.
Asks about cost first    → Budget-conscious. Flag expensive choices proactively.
Asks about security first → Compliance is critical context. Weight security higher.
Asks about UX first      → End-user experience trumps technical elegance.
```

### Approval signals — repeat the pattern
```
"yes", "exactly", "that's it", "I like this", "perfect" 
→ Note what you just did. Repeat that approach in similar situations.
```

### Rejection signals — never repeat the pattern
```
"no", "not like this", "too complex", "wrong", "not what I meant"
→ Note what you just did. Actively avoid it going forward.
   Apply the avoidance everywhere, not just the current feature.
```

---

## Preference Profile (maintain and update every turn)

```
## Preference Profile

TECHNICAL STYLE:
  Verbosity:            [minimal | balanced | detailed]
  Explanations:         [code-first | explain-then-code | code-with-comments]
  Complexity tolerance: [simple-always | pragmatic | ok-if-justified]
  Testing stance:       [skip-for-now | basic | full-tdd]
  Diagrams:             [always | on-request | skip]

STACK PREFERENCES:
  Language:             [TypeScript | Python | other — inferred or stated]
  CSS:                  [Tailwind | CSS modules | vanilla | other]
  State management:     [minimal | zustand | redux | context]
  DB:                   [postgres | mysql | mongo | sqlite]
  Cloud:                [aws | gcp | azure | agnostic | self-hosted]

COMMUNICATION:
  Pace:                 [fast-ship | deliberate]
  Questions tolerated:  [none-just-decide | minimal | happy-to-answer]
  Wants tradeoffs:      [yes | no — inferred from "why?" frequency]

BUSINESS CONTEXT:
  Stage:                [idea | mvp | scaling | mature]
  Team size:            [solo | small | medium | large]
  Timeline pressure:    [high | medium | low]

OBSERVED LIKES:
  - [pattern]: observed when [what they said/did]

OBSERVED AVOIDS:
  - [pattern]: triggered when [what they said/did]
```

---

## The Feedback Loop (how the skill actually improves)

This is the real learning mechanism. No magic — explicit signals in, explicit updates out.

### After every human message, Claude must:
1. Extract any preference signals (see types above)
2. Update the Preference Profile immediately
3. If a signal changes the approach, note it: "Updated: now defaulting to [X] because you said [Y]"
4. Apply the updated preference to the current response — not just future ones

### Feedback protocol (what to do with each signal type):

| Signal | Claude action |
|--------|--------------|
| "good" / approval | Note the pattern. Repeat it. |
| "not like this" / rejection | Identify exactly what failed. Avoid that pattern everywhere. |
| "simpler" | Set complexity-tolerance = simple. Immediately simplify current output too. |
| "more detail" | Set verbosity = detailed. Re-explain current section with more depth. |
| "wrong" | Identify root cause. Fix it. Add it to OBSERVED AVOIDS. |
| Test failure reported | Note which pattern produced the failure. Add to avoids. |
| Human edits Claude's code | Read what changed. That diff is a preference signal. |

### Between sessions:
Preferences are carried forward via `session-state.md` Preference Profile section.
The human pastes it at session start. Full preference context restored instantly.

---

## Single-Prompt Intelligence Protocol

**Goal:** From one rough prompt, produce output so accurate the human only needs "yes" or minor tweaks.

### Step 1: Front-load assumptions (never ask 5 questions)
State your assumptions explicitly and compactly. Invite silent correction:

> "Assuming: TypeScript, PostgreSQL, JWT auth, Railway deployment, B2C product.
> Say nothing if correct — or correct any that are wrong."

One sentence. All key assumptions visible. Human can correct in 5 words or say nothing.

### Step 2: Show the shape before the detail
Before 200 lines of code, show the skeleton:
- Data flow diagram (what connects to what)
- Wireframe (what the screen looks like)  
- Schema overview (tables and key relationships)

This catches misalignments before they cost hours of rework.

### Step 3: Build in layers, pause at layer boundaries (silently)

```
Layer 1: The thing that works       → MVP code, basic schema, happy path
Layer 2: The thing that scales      → caching, pagination, error handling
Layer 3: The thing that lasts       → tests, observability, voice, docs
```

Do not ask "should I continue to layer 2?" — proceed. But watch for a rejection
signal before writing layer 3 if layer 2 was contentious.

### Step 4: Calibrate immediately from every piece of feedback
Every response from the human is a calibration signal. Extract it. Update the profile.
Apply it to the current output, not just future ones.

---

## DevOps Templates (include in every project by default)

### GitHub Actions CI

```yaml
# .github/workflows/ci.yml
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env: { POSTGRES_PASSWORD: test, POSTGRES_DB: testdb }
        options: >-
          --health-cmd pg_isready --health-interval 10s --health-retries 5
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm' }
      - run: npm ci
      - run: npm run db:migrate
        env: { DATABASE_URL: postgresql://postgres:test@localhost/testdb }
      - run: npm test
      - run: npm run lint
      - run: npm run build

  deploy:
    needs: test
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: echo "Deploy command here"
        env: { DEPLOY_TOKEN: ${{ secrets.DEPLOY_TOKEN }} }
```

### Docker Compose (local dev)

```yaml
# docker-compose.yml
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: ${DB_NAME:-appdb}
      POSTGRES_PASSWORD: ${DB_PASSWORD:-localdev}
    volumes: [postgres_data:/var/lib/postgresql/data]
    ports: ["5432:5432"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]

  app:
    build: .
    depends_on:
      db: { condition: service_healthy }
      redis: { condition: service_started }
    environment:
      DATABASE_URL: postgresql://postgres:${DB_PASSWORD:-localdev}@db/${DB_NAME:-appdb}
      REDIS_URL: redis://redis:6379
    ports: ["3000:3000"]
    volumes: [.:/app, /app/node_modules]

volumes:
  postgres_data:
```

### Makefile

```makefile
.PHONY: setup dev test deploy

setup:
	cp -n .env.example .env || true
	npm install
	docker-compose up -d db redis
	npm run db:migrate
	npm run db:seed

dev:
	docker-compose up -d db redis
	npm run dev

test:
	docker-compose up -d db
	DATABASE_URL=postgresql://postgres:localdev@localhost/testdb npm test

deploy:
	npm run build
	npm run db:migrate:prod
	npm run start
```

### .env.example (document every variable)

```bash
# Database
DATABASE_URL=postgresql://postgres:password@localhost:5432/appdb
REDIS_URL=redis://localhost:6379

# Auth
JWT_SECRET=change-me-in-production
JWT_EXPIRY=15m
REFRESH_TOKEN_EXPIRY=7d

# App
NODE_ENV=development
PORT=3000
APP_URL=http://localhost:3000

# External services (all optional — configure in DB config table instead where possible)
# STRIPE_SECRET_KEY=
# OPENAI_API_KEY=
# TWILIO_ACCOUNT_SID=
```
