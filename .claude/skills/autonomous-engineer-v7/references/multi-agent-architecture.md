# Multi-Agent Architecture — Context Router

## The Problem

This skill has 30 reference files (~11,000 lines). Loading all of them causes:
- Information dilution (model forgets key rules)
- Hallucination (model invents things from mixed context)
- Fixation (model over-focuses on irrelevant file, ignores relevant one)

**Solution: Route tasks to focused sub-agents with minimal context.**

---

## The Router Pattern

```
┌────────────────────────────────────────────────────────────┐
│                     MANAGER AGENT                           │
│                                                             │
│  Reads ONLY:                                                │
│  • SKILL.md (825 lines — phases, rules, dimensions)        │
│  • execution-model.md (133 lines — commands, state)        │
│                                                             │
│  Does:                                                      │
│  • Classifies task type                                     │
│  • Looks up routing table                                   │
│  • Spawns sub-agent with ONLY those files                  │
│  • Collects output, scores, decides next step              │
└───────────────────────────┬────────────────────────────────┘
                            │
            ┌───────────────┼───────────────┐
            │               │               │
            ▼               ▼               ▼
    ┌───────────┐   ┌───────────┐   ┌───────────┐
    │  Backend  │   │ Frontend  │   │  DevOps   │
    │   Agent   │   │   Agent   │   │   Agent   │
    │           │   │           │   │           │
    │ 3-5 files │   │ 3-5 files │   │ 3-5 files │
    │ ~2k lines │   │ ~2k lines │   │ ~2k lines │
    └───────────┘   └───────────┘   └───────────┘
```

---

## 1. Routing Table

### Task Classification → File Set

| Task Type | Files to Load | Lines |
|-----------|---------------|-------|
| **API/Backend** | `arch-api.md`, `database-patterns.md`, `testing-verification.md` | ~1,500 |
| **Web Frontend** | `arch-web.md`, `ux-ergonomics.md`, `mockup-protocol.md` | ~680 |
| **Mobile** | `arch-mobile.md`, `platforms/flutter.md` or `platforms/react-native.md` | ~600 |
| **Database Design** | `database-patterns.md`, `decision-matrices.md` (section 2) | ~600 |
| **DevOps/Deploy** | `production-ops.md`, `observability.md` | ~900 |
| **Business/Strategy** | `business-patterns.md`, `market-research.md`, `study-questions.md` | ~400 |
| **Testing** | `testing-verification.md` | ~910 |
| **AI/LLM Features** | `platforms/ai-integration.md`, `missing-pieces.md` (section 4) | ~500 |
| **Multi-tenancy** | `missing-pieces.md` (sections 2, 5) | ~200 |
| **Security Review** | `missing-pieces.md` (section 7), `observability.md` | ~400 |

### Platform-Specific Additions

| If Stack Includes | Also Load |
|-------------------|-----------|
| NestJS | `platforms/nestjs.md` |
| Next.js | `platforms/nextjs.md` |
| Flutter | `platforms/flutter.md` |
| React Native | `platforms/react-native.md` |
| PHP/Laravel | `platforms/php.md` |

### Always Available (Don't Load Unless Asked)

| File | When to Load |
|------|--------------|
| `decision-matrices.md` | User asks "should I use X or Y?" |
| `git-workflow.md` | User asks about branching, commits, rollback |
| `communication-protocol.md` | User seems confused, needs clearer questions |
| `developer-dna-template.md` | Returning user, load preferences |

---

## 2. Manager Agent Prompt

```markdown
You are the Manager Agent for the autonomous-engineer skill.

## Your Context
You have loaded:
- SKILL.md (the full methodology: ORBIT loop, 14 rules, 17 dimensions)
- execution-model.md (commands, session state, what's real vs simulated)

## Your Job
1. Receive a task from the user
2. Classify it (see task types below)
3. Select the minimal file set from the routing table
4. Spawn a sub-agent with ONLY those files
5. Collect output
6. Score on relevant dimensions
7. Decide next step

## Task Types
- API/Backend: anything about services, endpoints, database queries
- Web Frontend: UI, components, pages, styling
- Mobile: iOS, Android, Flutter, React Native
- Database: schema design, migrations, queries, optimization
- DevOps: CI/CD, Docker, deployments, monitoring
- Business: pricing, competitors, revenue models
- Testing: test strategy, test writing, coverage
- AI/LLM: prompts, RAG, embeddings, cost tracking
- Security: auth, threats, encryption

## Routing Table
[Insert routing table from above]

## Output Format
{
  "task_type": "API/Backend",
  "files_to_load": ["arch-api.md", "database-patterns.md", "testing-verification.md"],
  "sub_agent": "backend",
  "task_for_sub_agent": "Design the order service with idempotent endpoints",
  "success_criteria": "Service layer isolated from DB, all endpoints idempotent, verification checklist included"
}
```

---

## 3. Sub-Agent Prompts

### Backend Agent

```markdown
You are a Backend Agent. You build APIs, services, and database interactions.

## Your Context
You have loaded:
- arch-api.md (service design, idempotency, OpenAPI)
- database-patterns.md (schema, indexing, queries)
- testing-verification.md (test pyramid, templates)

## Your Rules
1. Follow the 14 golden rules (especially: nothing hardcoded, idempotency, separation of concerns)
2. Output in this order: data flow diagram → schema → repository → service → controller → tests
3. Every code block needs a verification checklist

## Current Task
{task_from_manager}

## Success Criteria
{criteria_from_manager}
```

### Frontend Agent

```markdown
You are a Frontend Agent. You build UIs, components, and user experiences.

## Your Context
You have loaded:
- arch-web.md (Next.js patterns, config service)
- ux-ergonomics.md (eye-tracking, placement rules)
- mockup-protocol.md (wireframes before code)

## Your Rules
1. Mockup before code (ASCII → wireframe → confirm → code)
2. F-pattern for reading-heavy, Z-pattern for action-heavy
3. Thumb zone for mobile interactions
4. No aesthetic guesses — research-backed placement only

## Current Task
{task_from_manager}
```

### DevOps Agent

```markdown
You are a DevOps Agent. You handle CI/CD, containers, deployments, and operations.

## Your Context
You have loaded:
- production-ops.md (CI/CD, Docker, deployments, disaster recovery)
- observability.md (logging, metrics, tracing)

## Your Rules
1. Every change is reversible (git tag before deploy)
2. Blue-green for zero-downtime, canary for risky changes
3. Health checks on every service
4. Backup script tested (actually restored)

## Current Task
{task_from_manager}
```

---

## 4. Implementation

### Option A: Single Model with Dynamic Loading

If using Claude with file access (Claude.ai or Claude Code):

```python
# router.py
ROUTING_TABLE = {
    "backend": ["arch-api.md", "database-patterns.md", "testing-verification.md"],
    "frontend": ["arch-web.md", "ux-ergonomics.md", "mockup-protocol.md"],
    "devops": ["production-ops.md", "observability.md"],
    "database": ["database-patterns.md", "decision-matrices.md"],
    "testing": ["testing-verification.md"],
    "business": ["business-patterns.md", "market-research.md"],
    "ai": ["platforms/ai-integration.md", "missing-pieces.md"],
}

def classify_task(task: str) -> str:
    """Use LLM to classify task type."""
    # Simple keyword matching or LLM classification
    keywords = {
        "backend": ["api", "endpoint", "service", "controller", "repository"],
        "frontend": ["ui", "component", "page", "form", "button", "layout"],
        "devops": ["deploy", "docker", "ci", "cd", "pipeline", "kubernetes"],
        "database": ["schema", "table", "index", "query", "migration"],
        "testing": ["test", "coverage", "jest", "pytest", "e2e"],
        "business": ["pricing", "competitor", "revenue", "market"],
        "ai": ["llm", "prompt", "embedding", "rag", "openai", "anthropic"],
    }
    task_lower = task.lower()
    for task_type, words in keywords.items():
        if any(word in task_lower for word in words):
            return task_type
    return "backend"  # default

def load_context(task_type: str, base_path: str) -> str:
    """Load only the relevant files."""
    files = ROUTING_TABLE.get(task_type, ROUTING_TABLE["backend"])
    context = ""
    for filename in files:
        filepath = f"{base_path}/references/{filename}"
        with open(filepath, "r") as f:
            context += f"\n\n# {filename}\n\n{f.read()}"
    return context

# Usage
task = "Build the restaurant pricing verification API"
task_type = classify_task(task)  # "backend"
context = load_context(task_type, "/path/to/skill")
# Now send context + task to LLM
```

### Option B: LangGraph Multi-Agent

```python
# langgraph_router.py
from langgraph.graph import StateGraph, END
from typing import TypedDict, Literal

class AgentState(TypedDict):
    task: str
    task_type: str
    files_loaded: list[str]
    sub_agent_output: str
    scores: dict
    next_step: str

def manager_node(state: AgentState) -> AgentState:
    """Manager classifies and routes."""
    task_type = classify_task(state["task"])
    files = ROUTING_TABLE[task_type]
    return {
        **state,
        "task_type": task_type,
        "files_loaded": files,
    }

def backend_node(state: AgentState) -> AgentState:
    """Backend agent with focused context."""
    context = load_context("backend", BASE_PATH)
    prompt = f"{BACKEND_AGENT_PROMPT}\n\n{context}\n\nTask: {state['task']}"
    output = llm.invoke(prompt)
    return {**state, "sub_agent_output": output}

def frontend_node(state: AgentState) -> AgentState:
    """Frontend agent with focused context."""
    context = load_context("frontend", BASE_PATH)
    prompt = f"{FRONTEND_AGENT_PROMPT}\n\n{context}\n\nTask: {state['task']}"
    output = llm.invoke(prompt)
    return {**state, "sub_agent_output": output}

def critic_node(state: AgentState) -> AgentState:
    """Score output on relevant dimensions."""
    scores = score_output(state["sub_agent_output"], state["task_type"])
    lowest = min(scores, key=scores.get)
    return {
        **state,
        "scores": scores,
        "next_step": "done" if scores[lowest] >= 4 else lowest,
    }

def route_to_agent(state: AgentState) -> Literal["backend", "frontend", "devops"]:
    """Route based on task type."""
    return state["task_type"]

# Build graph
graph = StateGraph(AgentState)
graph.add_node("manager", manager_node)
graph.add_node("backend", backend_node)
graph.add_node("frontend", frontend_node)
graph.add_node("critic", critic_node)

graph.set_entry_point("manager")
graph.add_conditional_edges("manager", route_to_agent)
graph.add_edge("backend", "critic")
graph.add_edge("frontend", "critic")
graph.add_conditional_edges("critic", lambda s: END if s["next_step"] == "done" else "manager")

app = graph.compile()
```

### Option C: Claude Code with File Selection

```bash
#!/bin/bash
# route_and_build.sh

TASK="$1"
SKILL_PATH="/path/to/autonomous-engineer"

# Step 1: Manager classifies
TASK_TYPE=$(claude --print "Classify this task into one of: backend, frontend, devops, database, testing, business, ai. Task: $TASK. Output only the type, nothing else.")

# Step 2: Load relevant files
case $TASK_TYPE in
  backend)
    FILES="arch-api.md database-patterns.md testing-verification.md"
    ;;
  frontend)
    FILES="arch-web.md ux-ergonomics.md mockup-protocol.md"
    ;;
  devops)
    FILES="production-ops.md observability.md"
    ;;
  *)
    FILES="arch-api.md database-patterns.md"
    ;;
esac

# Step 3: Build context
CONTEXT=""
for f in $FILES; do
  CONTEXT="$CONTEXT\n\n$(cat $SKILL_PATH/references/$f)"
done

# Step 4: Execute with focused context
echo -e "$CONTEXT" | claude --print "You are a $TASK_TYPE agent. Context above. Task: $TASK"
```

---

## 5. Context Budget Guide

| Model | Context Limit | Safe Budget | Files to Load |
|-------|---------------|-------------|---------------|
| Claude 3.5 Sonnet | 200k | ~50k | 4-5 reference files |
| Claude 3 Opus | 200k | ~50k | 4-5 reference files |
| Claude 3 Haiku | 200k | ~30k | 2-3 reference files |
| GPT-4 Turbo | 128k | ~40k | 3-4 reference files |
| GPT-4o | 128k | ~40k | 3-4 reference files |

**Rule: Never load more than 5 reference files at once.**

If a task needs more, split it:
1. First pass: architecture decisions (decision-matrices.md)
2. Second pass: implementation (arch-*.md + platform guide)
3. Third pass: testing (testing-verification.md)
4. Fourth pass: deployment (production-ops.md)

---

## 6. When to Use Multi-Agent vs Single Model

| Situation | Approach |
|-----------|----------|
| Quick task, clear scope | Single model + 2-3 files |
| Complex task, multiple domains | Multi-agent with router |
| Parallel work streams | Multi-agent (LangGraph) |
| Need code execution | Claude Code |
| Need 24/7 background | Add scheduler (Temporal, BullMQ) |

**Start simple. Add agents only when single model breaks.**

---

## 7. Session Handoff Between Agents

When a sub-agent completes, it outputs:

```json
{
  "task_completed": "Order service implementation",
  "files_created": ["order.service.ts", "order.repository.ts", "order.controller.ts"],
  "scores": {
    "architecture": 4,
    "db_driven_config": 4,
    "testing": 3
  },
  "gaps": ["Test coverage at 60%, need journey tests"],
  "next_agent": "testing",
  "context_for_next": "Order service uses repository pattern, needs tests for create/update/cancel flows"
}
```

Manager reads this and routes to Testing Agent with only `testing-verification.md` loaded.

---

## Quick Start

1. **User says**: "Build the restaurant pricing verification API"
2. **Manager classifies**: backend
3. **Manager loads**: arch-api.md, database-patterns.md, testing-verification.md
4. **Backend Agent builds**: with focused context (~1,500 lines, not 11,000)
5. **Critic scores**: architecture 4, testing 3, devops 2
6. **Manager routes**: to DevOps Agent for CI/CD
7. **DevOps Agent builds**: with production-ops.md only
8. **Loop until all scores ≥ 4**

The model never sees 30 files at once. It stays focused. Output quality goes up.
