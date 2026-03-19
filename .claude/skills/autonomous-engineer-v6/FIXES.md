# Autonomous Engineer Skill — Fixes & Improvements

## Version 6 Changes (Latest)

### NEW: Core Principles Section
Added 7 core principles at the top of SKILL.md:
1. Goal First — understand before building
2. Simplicity — less code is better
3. Self-Verifying — no human checking needed
4. Auto-Cleanup — test → verify → remove dead code
5. Clear Questions — options + consequences
6. Clear Estimates — specific times
7. Clear Documentation — what happens if

### NEW: Communication Protocol Reference File
Added `references/communication-protocol.md` with:
- Goal extraction templates (problem vs feature vs question)
- Clear planning template with estimates
- Question protocol (options + consequences, never open-ended)
- Self-verification protocol (every code block verifiable in 30 seconds)
- Code simplicity rules
- Auto-cleanup protocol
- Performance optimization checklist
- Documentation template
- Estimation guidelines with specific times

### Updated: Phase 0 — ORIENT
Now starts with explicit goal extraction:
- If PROBLEM: Quick fix / Proper fix / Full refactor options
- If FEATURE: Prototype / MVP / Production options
- Shows plan with specific time estimates before starting work
- Business model questions use checkbox format

### Updated: Phase 3 — BUILD
Added new sections:
- **Simplicity Rules**: Minimum viable code, one file until needed, no premature abstraction
- **Auto-Cleanup Protocol**: Test → verify → remove dead code → report
- **Self-Verification**: Every code block has exact commands + expected output + error fixes
- **Performance Check**: Quick scan before delivering any code

### Updated: Reference Files
- Now 18 files (added communication-protocol.md)
- Decision tree starts with communication-protocol.md for new users

## Fix 1: Voice Integration (Optional, Not Required)

### In SKILL.md, replace lines 148:
```
OLD: 6. Voice-native — every user-facing interface has a voice channel
NEW: 6. Voice-aware — consider voice channel for user-facing interfaces; skip if not relevant to product
```

### In SKILL.md, replace line 96 (Phase 1 STUDY):
```
OLD: 6. Voice — every product gets a voice channel. How does it fit?
NEW: 6. Voice — would voice add value? (Consumer apps: likely yes. B2B/dev tools: likely no)
```

### In gap-analysis.md, replace Dimension 7:
```
OLD:
### 7. Voice Integration
**Signs of gaps:** Text-only input. No voice channel on any user-facing interface.
**Fix:** STT (Whisper OSS) + TTS (Coqui OSS) adapter. Same service layer as text.
Voice config in DB. See `voice-integration.md`.

NEW:
### 7. Voice Integration (where applicable)
**When to apply:** Consumer-facing apps, accessibility-critical products, hands-free use cases.
**When to skip:** B2B dashboards, developer tools, admin panels, API-only products.
**Signs of gaps (when applicable):** Text-only input where voice would improve UX.
**Fix:** STT (Whisper OSS) + TTS (Coqui OSS) adapter. Same service layer as text.
Voice config in DB. See `voice-integration.md`.
**Score 5 if:** Voice not applicable AND explicitly noted as "N/A — [reason]"
```

---

## Fix 2: Rename "12 Golden Rules" to "14 Golden Rules"

### In SKILL.md, replace line 137:
```
OLD: ### The 12 Golden Rules
NEW: ### The 14 Golden Rules
```

---

## Fix 3: Add Brownfield-Specific Guidance

### Add new section in SKILL.md after line 74:

```markdown
### Brownfield Workflow (Existing Codebases)

When working with existing code, follow this sequence:

**Step 1: Audit Before Proposing**
```
Run 17-dimension scoring on existing code FIRST.
Do NOT propose changes until audit is complete.
```

**Step 2: Incremental Improvement (Never Full Rewrite)**
```
WRONG: "Let's rebuild this properly from scratch"
RIGHT: "Current auth is dimension 2. Here's how to reach dimension 4 without breaking existing flows."
```

**Step 3: Strangler Fig Pattern**
For replacing legacy components:
1. Build new component alongside old
2. Route traffic gradually (feature flag in DB)
3. Monitor for parity
4. Remove old when new is proven
5. Never cut over in one deploy

**Step 4: Preserve Working Code**
```
SACRED: Code that is currently working in production
CHANGEABLE: Code with failing tests or no tests
QUESTIONABLE: Code with tests but unclear behavior — add tests first, then change
```

**Step 5: Document What Survives**
Every refactor response must include:
- What existing code is preserved
- What is being replaced
- What the migration path is
```

---

## Fix 4: Add Error Recovery Protocol

### Add new section in SKILL.md before "Autonomous Loop Protocol":

```markdown
## Error Recovery Protocol

### When Claude Makes a Mistake

1. **Acknowledge immediately** — "That approach won't work because [X]. Let me fix it."
2. **Identify root cause** — Not just the symptom
3. **Propose minimal fix** — Don't rewrite everything; fix the specific issue
4. **Update OBSERVED AVOIDS** — Learn from the mistake for this session

### When User Says "Go Back"

1. **Clarify scope** — "Go back to before [specific change], or start fresh?"
2. **If specific rollback:**
   - Identify the last known-good state
   - Show diff of what will be undone
   - Apply rollback
3. **If start fresh:**
   - Preserve Project Brief and Preference Profile
   - Clear code artifacts
   - Restart from Phase 0 with learned preferences

### When Refactor Breaks Something

1. **Do not panic-rewrite**
2. **Isolate the break** — What specific change caused it?
3. **Propose two paths:**
   - Revert the breaking change (safe)
   - Fix forward with minimal patch (if cause is clear)
4. **Let human choose**
```

---

## Fix 5: Add Prototype Mode

### Add to SKILL.md under "Autonomous Loop Protocol":

```markdown
### Prototype Mode

Triggered when human says: "quick prototype", "just get it working", "MVP", "proof of concept"

**What changes:**
- Still run full ORBIT loop
- Still score all 17 dimensions
- BUT: Target score 3 (functional) instead of 4 (production-ready)
- Skip: voice integration, full test coverage, multi-tenancy, i18n
- Include: working code, basic error handling, verification checklist

**What stays the same:**
- Diagrams before code (still required — prevents rework)
- Config table (still required — avoids hardcoding debt)
- CI/CD skeleton (still required — easier to add later)

**Exit prototype mode:** Human says "make it production-ready" or "ship it"
→ Run full 17-dimension audit, fix gaps to reach 4+ on all dimensions.
```

---

## Fix 6: Add Reference File Router

### Add to SKILL.md after the reference file table:

```markdown
### Reference File Decision Tree

**Starting a new project?**
1. Read `study-questions.md` (project intake)
2. Read `market-research.md` (competitor analysis)
3. Read arch file for your type:
   - Web app → `arch-web.md`
   - Mobile → `arch-mobile.md`
   - API/microservices → `arch-api.md`
   - Data/ML → `arch-data-ml.md`

**Designing UI?**
→ Read `ux-ergonomics.md` + `diagrams-wireframes.md`

**Writing code?**
→ Read relevant arch file + `testing-verification.md`

**Reviewing existing code?**
→ Read `gap-analysis.md` first, then relevant arch file

**Adding paid services (OpenAI, Twilio, etc.)?**
→ Read `missing-pieces.md` (cost awareness section)

**Building B2B/SaaS?**
→ Read `missing-pieces.md` (multi-tenancy + monetisation sections)

**Session ending?**
→ Read `execution-model.md` (session state template)
```

---

## Fix 7: Clarify 14 Rules vs 17 Dimensions Relationship

### Add to SKILL.md after the 14 Golden Rules:

```markdown
### How Rules Relate to Dimensions

The **14 Golden Rules** are BUILD-TIME constraints — apply them while writing code.
The **17 Dimensions** are SCORING criteria — use them to evaluate completeness.

| Rule | Maps to Dimension(s) |
|------|---------------------|
| 1. Nothing hardcoded | 2. Database-driven config |
| 2. Database-driven | 2. Database-driven config |
| 3. Separation of concerns | 1. Architecture correctness |
| 4. Idempotency | 1. Architecture, 13. Security |
| 5. Observability first | 14. Observability |
| 6. Voice-aware | 7. Voice integration |
| 7. Scalability-first | 8. Scalability |
| 8. Future-redundant | 8. Scalability, 17. OSS preference |
| 9. Transparent | 12. Transparency |
| 10. Open-source preferred | 17. OSS preference |
| 11. Ergonomic UI | 5. UX ergonomics |
| 12. DevOps from day one | 16. DevOps |
| 13. Every action has reaction | 15. Test coverage |
| 14. Human journeys | 15. Test coverage |

**Not covered by rules (must track via dimensions):**
- 3. Business model alignment
- 4. Competitor differentiation
- 6. Diagrams & wireframes shown
- 9. Multi-tenancy
- 10. Cost awareness
- 11. LLM integration
```
