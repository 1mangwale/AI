# Multi-Agent Architecture — When and How to Scale

## When Single-Model Is Enough

This skill runs as a single model and that's the right default. Single-model is:
- Fast to start (no infrastructure)
- Coherent (one context, no coordination overhead)
- Good enough for 90% of real projects

Use single-model (this skill) when:
- Solo developer or small team
- Project is in design / early build phase
- Work streams are sequential, not parallel

---

## When to Split Into Multiple Agents

Split when you hit these signals:
- Research is stale by the time code is written (parallel research needed)
- Code needs to actually run and be tested (executor agent needed)
- Project has 3+ people contributing simultaneously (coordination needed)
- You need 24/7 background processing (scheduler needed)

---

## The Full Multi-Agent Design

```
┌─────────────────────────────────────────────────────────┐
│                    ORCHESTRATOR                          │
│          Reads Project Brief, assigns work               │
└──────────┬──────────┬────────────┬──────────┬───────────┘
           │          │            │          │
    ┌──────▼──┐ ┌─────▼────┐ ┌────▼────┐ ┌───▼──────┐
    │ PLANNER │ │ RESEARCH │ │ BUILDER │ │  CRITIC  │
    │         │ │          │ │         │ │          │
    │ ORBIT   │ │ Market   │ │ Code +  │ │ Scores   │
    │ roadmap │ │ UX data  │ │ Arch    │ │ 15 dims  │
    │ backlog │ │ live docs│ │ DevOps  │ │ finds    │
    │ scope   │ │ tech news│ │ voice   │ │ gaps     │
    └─────────┘ └──────────┘ └────────┘ └──────────┘
           │          │            │          │
    ┌──────▼──────────▼────────────▼──────────▼───────────┐
    │                   MEMORY AGENT                       │
    │  project.json · preferences.json · backlog.json      │
    │  decisions.json · scores.json · session-state.md     │
    └────────────────────────┬────────────────────────────┘
                             │
                    ┌────────▼────────┐
                    │    EXECUTOR     │
                    │  Runs code      │
                    │  Tests output   │
                    │  Validates      │
                    │  Reports result │
                    └─────────────────┘
```

---

## Agent Specifications

### Planner Agent
**Prompt role**: "You are a technical project manager. Given a Project Brief and current
scores, produce: (1) the ORBIT phase for this turn, (2) the specific task, (3) what
success looks like, (4) what the next 3 tasks are."

**Input**: Project Brief + Preference Profile + current scores + backlog
**Output**: Structured task assignment JSON
**Model**: Fast/cheap model (Haiku-class) — planning is lightweight

```json
{
  "phase": "BUILD",
  "task": "Write the repository layer for the orders domain",
  "success_criteria": "All DB access isolated in OrderRepository, service layer has no SQL",
  "next_tasks": [
    "Write service layer for orders",
    "Add input validation schema",
    "Write unit tests for order creation"
  ]
}
```

### Research Agent
**Prompt role**: "You are a research analyst. Given a technology or domain, produce:
(1) latest version + recent breaking changes, (2) top 3 competitors + what they do,
(3) OSS alternatives, (4) key documentation URLs to fetch."

**Input**: Technology name or market domain
**Output**: Structured research report
**Tools needed**: web_search, web_fetch
**Model**: Full model needed — research quality matters

### Builder Agent
**Prompt role**: "You are a senior software engineer. Given a task specification and
research context, write production-quality code following the 12 golden rules. Output:
(1) data flow diagram, (2) code files in correct order, (3) verification checklist."

**Input**: Task spec + research + architecture context
**Output**: Code + diagrams + verification steps
**Tools needed**: code execution (Claude Code environment)
**Model**: Full model — code quality matters

### Critic Agent
**Prompt role**: "You are a technical reviewer. Score this code/architecture on 15
dimensions (1-5 each). For each score < 4, explain the specific gap and the fix."

**Input**: Code output from Builder
**Output**: Scored JSON + prioritised fix list
**Model**: Full model — scoring needs genuine judgment

```json
{
  "scores": {
    "architecture": 4,
    "db_driven_config": 3,
    "voice_integration": 1,
    "security": 3
  },
  "gaps": [
    {
      "dimension": "voice_integration",
      "score": 1,
      "gap": "No voice adapter exists. Text input only.",
      "fix": "Add /voice/transcribe endpoint using Whisper. Wire to existing service layer."
    }
  ],
  "next_target": "voice_integration"
}
```

### Memory Agent
**Stores and retrieves**:

```
project-state/
├── project.json          # Project Brief (never changes once set)
├── preferences.json      # Preference Profile (updates every turn)
├── backlog.json          # Backlog items with priority
├── scores.json           # Latest dimension scores
├── decisions.json        # Architecture decisions + rationale (ADRs)
└── session-state.md      # Human-readable summary for session handoff
```

**Update protocol**:
- After every ORIENT turn → update preferences.json
- After every BUILD turn → update backlog.json (mark done items)
- After every IMPROVE turn → update scores.json
- After every major decision → append to decisions.json
- At session end → regenerate session-state.md

### Executor Agent
**Runs code and validates it actually works.**

Without Claude Code or a code sandbox, this is the verification checklist.
With Claude Code, this becomes actual execution.

**Validation protocol for every code block:**
```
1. Does it compile / parse without errors?
2. Does the happy path work?
3. Does it handle the top 3 failure modes?
4. Does it match the architecture diagram?
5. Are there hardcoded values that should be in config?
```

---

## Building This With Claude Code (Real Executor)

If running in Claude Code environment:

```bash
# The Builder writes code to files
# The Executor actually runs it

# Step 1: Write
claude "Write the OrderRepository class per the spec" > order.repository.ts

# Step 2: Test
npx ts-node order.repository.ts
npm test -- --grep "OrderRepository"

# Step 3: Score
claude "Score this file on the 15 dimensions" < order.repository.ts

# Step 4: Fix lowest score
claude "Fix the lowest-scoring dimension in this file" < order.repository.ts

# Step 5: Loop
# Repeat until all scores >= 4
```

---

## Orchestration Framework Options (When You Need Real Autonomy)

| Framework | Language | Best for |
|-----------|----------|----------|
| LangGraph | Python | Complex state machines, cycles |
| CrewAI | Python | Role-based multi-agent teams |
| AutoGen | Python | Conversational multi-agent |
| Mastra | TypeScript | TypeScript-native agent workflows |
| Claude Code | Any | Direct code execution + file ops |

**Recommended path:**
1. Start with this skill (single model, conversation-based)
2. When you need code execution → move to Claude Code
3. When you need parallel agents → move to LangGraph or CrewAI
4. When you need 24/7 background → add a scheduler (Temporal, BullMQ)

---

## State Persistence Options

| Option | Where | When to use |
|--------|-------|-------------|
| Session State Doc | Paste at turn 1 | Any conversation-based work |
| Claude Memory | claude.ai settings | Personal preference persistence |
| Git repo | GitHub | Code + ADRs + architecture decisions |
| JSON files | Local / S3 | When running with Claude Code |
| PostgreSQL | DB | Production multi-agent system |
| Redis | Cache | Fast state reads in agent loop |
