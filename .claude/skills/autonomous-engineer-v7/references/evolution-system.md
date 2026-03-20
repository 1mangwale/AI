# Self-Evolution System

## How This Skill Learns You

```
┌─────────────────────────────────────────────────────────────┐
│                    EVOLUTION LOOP                           │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   SESSION 1 ──► Extract Patterns ──► Developer DNA v1      │
│                                            │                │
│   SESSION 2 ──► Apply DNA v1 ──► Learn ──► Developer DNA v2│
│                                            │                │
│   SESSION N ──► Apply DNA v(n-1) ──► ──► Developer DNA vN  │
│                                                             │
│   Each session: skill gets smarter about YOU                │
└─────────────────────────────────────────────────────────────┘
```

---

## Developer DNA File

After significant work, generate `developer-dna.md`. User saves it. Paste at session start.

```markdown
# Developer DNA — [Your Name] — v[N] — [Date]

## Stack Preferences
```yaml
backend: nestjs | laravel | [other]
frontend: nextjs | react | vue | [other]
mobile: react-native | flutter | [other]
database: postgresql | mysql | mongodb
orm: prisma | typeorm | eloquent
styling: tailwind | css-modules | styled-components
state: zustand | redux | riverpod
testing: jest | vitest | phpunit
ci: github-actions | gitlab-ci
deploy: vercel | railway | aws
```

## Code Style
```yaml
naming: camelCase | snake_case | kebab-case
components: single-file | split
comments: minimal | moderate | verbose
types: strict | loose
error-handling: try-catch | result-type | either
file-length-max: 200 | 300 | 500
```

## Patterns I Like
- [Pattern]: Used in [project], worked because [reason]
- [Pattern]: ...

## Patterns I Hate
- [Anti-pattern]: Rejected in [context], because [reason]
- [Anti-pattern]: ...

## Architecture Decisions
- [Decision]: Chose [X] over [Y] because [reason]
- [Decision]: ...

## UI/UX Preferences
```yaml
aesthetic: minimal | bold | corporate | playful
density: spacious | balanced | compact
animations: subtle | moderate | expressive
dark-mode: prefer | light-prefer | system
```

## Communication Style
```yaml
verbosity: minimal | balanced | detailed
explanations: code-first | explain-then-code
questions: batch | one-at-a-time
mockups: always | on-request
```

## Past Projects (learnings)
### [Project 1]
- Stack: ...
- What worked: ...
- What I'd change: ...

### [Project 2]
- ...

## Evolution Log
- v1 [date]: Initial profile from [project]
- v2 [date]: Added [learning] from [project]
- v3 [date]: ...
```

---

## Learning Extraction Protocol

**After EVERY significant task, Claude must:**

```
## What I Learned About You

### Confirmed Preferences
- You prefer [X] because you [signal]
- You like [Y] — approved quickly

### New Discoveries  
- First time seeing you use [Z]
- You rejected [A] — adding to "Patterns I Hate"

### DNA Update Needed?
□ Yes — significant new patterns discovered
□ No — consistent with existing DNA

[If yes, generate updated developer-dna.md]
```

---

## Session Start Protocol

```
IF user pastes developer-dna.md:
  → Load all preferences
  → Apply to all decisions
  → Say: "DNA loaded (v[N]). I know your stack, style, and patterns."

IF no DNA but returning user:
  → Ask: "Do you have your developer-dna.md? Paste it for personalized experience."

IF new user:
  → Start fresh
  → Build DNA as we work
  → Offer to generate DNA after first significant task
```

---

## Continuous Learning Signals

**Track these in real-time:**

| Signal | What It Means | Action |
|--------|---------------|--------|
| User edits my code | Their style differs | Note the diff, adapt |
| "I prefer X" | Explicit preference | Lock it in DNA |
| "Don't do Y" | Hard constraint | Add to "Patterns I Hate" |
| Quick approval | Pattern worked | Reinforce |
| "Not like this" | Pattern failed | Add to avoid list |
| User's existing code | Their actual style | Match it |
| Uploaded design | Their aesthetic | Extract and match |

---

## Evolution Metrics

Track improvement over sessions:

```
Session 1: Asked 5 clarifying questions
Session 2: Asked 3 clarifying questions  
Session 3: Asked 1 clarifying question
Session 4: Zero questions — I know you now
```

Goal: By session 3-4, zero clarifications needed.

---

## Memory Integration

**If Claude Memory is enabled (claude.ai):**
```
Store in memory:
- Stack preferences
- Code style patterns
- Architecture decisions
- Rejected patterns

Retrieve automatically on new session.
No need to paste DNA file.
```

**If Memory not enabled:**
```
Generate developer-dna.md
User saves locally
User pastes at session start
```

---

## Example Evolution

```
SESSION 1:
User: "Build me an API"
Claude: "What framework? NestJS, Express, Laravel?"
User: "NestJS"
→ DNA: backend: nestjs

SESSION 2:
User: "Build another API"
Claude: [Knows to use NestJS, doesn't ask]
User: "Use Prisma not TypeORM"
→ DNA: orm: prisma

SESSION 3:
User: "New project"
Claude: [Uses NestJS + Prisma automatically]
User: [Approves]
→ DNA: Confirmed patterns

SESSION 10:
User: "Build X"
Claude: [Knows stack, style, patterns, preferences — builds exactly right first time]
```

---

## Generating DNA Update

At session end (or on request):

```
## Developer DNA Update

Changes from this session:
+ Added: [new preference]
+ Confirmed: [existing preference]
- Removed: [outdated preference]
~ Changed: [modified preference]

[Full updated developer-dna.md below]
```
