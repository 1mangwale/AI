# Execution Model — What Is Real vs Simulated

## The Honest Truth First

This skill runs inside a conversation. Claude responds turn-by-turn.
There is no background process, scheduler, or daemon between messages.

Knowing this makes the skill MORE useful — you build compensating mechanisms
instead of being surprised when things reset.

---

## What IS Real

| Capability | What it means |
|-----------|---------------|
| In-turn ORBIT loop | Within one response: research → build → score → plan next. Fully real. |
| In-context memory | Everything in the current conversation stays in context. Project Brief, Preference Profile, Backlog all live here. |
| Web research | web_search + web_fetch for live docs, competitors, tech news before every relevant build step. |
| Self-scoring | 17-dimension honest scoring drives genuine improvement. See `gap-analysis.md` for scoring definitions. |
| Autonomous progression | Within a session: no waiting, no asking permission, no "shall I continue?". Real. |

---

## What Is SIMULATED + How We Compensate

### ❌ Cross-session memory
Every new conversation starts fresh. Preference Profile and Project Brief reset.

**Compensation → Session State Document**
At the end of every significant session, generate `session-state.md`:

```markdown
# Session State — [Project] — [Date]

## Project Brief
Product: / Business model: / Core user: / Value prop: / Tech stack: / Stage:

## Preference Profile
Verbosity: [minimal|balanced|detailed]
Complexity: [simple|pragmatic|ok-if-justified]
Likes: [patterns that worked]
Avoids: [patterns rejected]
Testing: [skip|basic|full-tdd]

## Scores (last session)
| Dimension | Score | Gap |
|-----------|-------|-----|
| [each dimension] | [1-5] | [top gap] |

## Backlog
- [ ] [item] — [priority] — [deferred because]

## Completed this session
[what was built/decided]

## Next session: start here
[specific next task]
```

Human pastes this at turn 1 → full context restored instantly.
Skill detects it and says: "Context restored. Continuing from [next task]."

---

### ❌ Background looping
"Keep improving without waiting" means Claude chains improvements *within* a response.
It does NOT mean running between messages.

**Compensation → Continuation Commands**

| Human types | Claude does |
|------------|-------------|
| `continue` | Execute next backlog item immediately, no preamble |
| `status` | Show scores table + backlog + next planned step |
| `ship it` | Generate final output package + session state doc |
| `review` | Audit existing code against all 17 dimensions |
| `[paste session-state.md]` | Restore full context, resume from where left off |

---

### ❌ Real code execution
The skill writes code but cannot compile, run, or test it.

**Compensation → Verification Checklist (every code block)**
```
VERIFY THIS:
[ ] Run:             [exact copy-paste command]
[ ] Expected output: [what success looks like]
[ ] Error case 1:    [command] → [expected error response]
[ ] If it fails:     [most likely cause + one-line fix]
```

This turns "trust me it works" into "here's exactly how to verify."

---

### ❌ True self-improvement between sessions
Learning does not persist automatically across conversations.

**Compensation → Explicit feedback protocol**
Human signals update the Preference Profile immediately and are carried in session state.
See `self-learning.md` for the full signal taxonomy and feedback loop.

---

## The Multi-Agent Simulation Map

This skill simulates a full multi-agent system inside a single model:

| Real Agent | This Skill Simulates Via |
|-----------|--------------------------|
| Planner | ORBIT loop + scoring table + backlog |
| Research | Phase 2 (web_search + web_fetch every turn) |
| Builder | Phase 3 code output protocol |
| Critic | Phase 4 honest 17-dimension scoring |
| Memory | Session State Document |
| Executor | Verification checklist + test templates |

Single-model simulation is right for 90% of projects. See `multi-agent-architecture.md`
for when and how to upgrade to real parallel agents with actual execution.

---

## When This Skill Is Enough vs When to Upgrade

| Situation | Use this skill | Upgrade to |
|-----------|---------------|------------|
| Design + build + iterate | ✅ | — |
| Need actual code to run | ❌ | Claude Code |
| Parallel work streams | ❌ | LangGraph / CrewAI |
| 24/7 background processing | ❌ | + Temporal / BullMQ |
| True persistent memory | ❌ | + PostgreSQL state store |
