# User Journey Questioning Protocol

## Philosophy

**Ask questions the way a user thinks, not how a developer thinks.**

Don't ask: "Should we use REST or GraphQL?"
Ask: "When a user clicks 'Buy Now', what should they see next?"

---

## Journey-First Questions

### Start Here (Always)

```
**Q1: Walk me through what a user does, step by step.**

"I'm [user type]. I open the app because I want to [goal].
First, I see [screen]. I click [button]. Then..."

A) Let me describe it
B) I have a mockup/design to share
C) Reference another product (e.g., "like Uber but for X")
D) I'm not sure yet — help me think through it
```

### Journey Mapping Template

```
**Journey: [Name, e.g., "New User Signup"]**

Trigger: What makes the user start this journey?
A) They decided to try the product
B) Someone invited them
C) They need to do [specific task]
D) Other: ___

Step 1: What do they see first?
A) Landing page
B) Login/signup screen
C) Onboarding wizard
D) Straight to the main feature

Step 2: What do they do?
A) Fill out a form
B) Click a button
C) Browse content
D) Other: ___

Step 3: What happens next?
[Continue until journey complete...]

Success: How do they know it worked?
A) Confirmation message
B) Redirect to [where]
C) Email/notification
D) Something visual changes

Failure: What could go wrong?
A) Validation error
B) Server error
C) User abandons
D) [List specific edge cases]
```

---

## User Persona Questions

### Who Is This For?

```
**Q: Describe your typical user.**

Demographics:
A) Young professional (25-35)
B) Tech-savvy consumer
C) Business user / professional
D) Non-technical / general public
E) Developer / technical

Tech comfort:
A) Needs hand-holding (clear instructions)
B) Figures things out (minimal guidance)
C) Power user (wants shortcuts, efficiency)
D) Mixed audience

Usage context:
A) Desktop at work
B) Mobile on the go
C) Both equally
D) Programmatic (API)

Frequency:
A) Daily habit
B) Weekly / regular
C) Occasional / as needed
D) One-time setup
```

### What's Their Mindset?

```
**Q: When a user comes to your app, they are thinking...**

A) "I need to do this quickly" (task-focused)
B) "I want to explore/browse" (discovery)
C) "I have a problem to solve" (help-seeking)
D) "I'm checking on something" (monitoring)
E) "Someone told me to use this" (mandated)
```

---

## Feature-Level Questions

### For Each Feature

```
**Feature: [Name]**

Q1: Who uses this feature?
A) All users
B) Specific user type: ___
C) Admin only
D) Optional / power users

Q2: How often?
A) Every session
B) Occasionally
C) Rarely / one-time setup
D) Never directly (background process)

Q3: What triggers it?
A) User clicks [what]
B) Time-based (schedule)
C) Event-based (when X happens)
D) Automatic

Q4: What inputs are needed?
[List all form fields, data, etc.]

Q5: What's the output?
A) Data saved
B) Action triggered
C) Content displayed
D) File generated

Q6: What can go wrong?
[List all failure modes]

Q7: How is success shown?
A) Toast/notification
B) Page change
C) Visual update
D) Email confirmation
```

---

## Edge Case Discovery

### Ask For Each Journey

```
**What if...**

1. User enters invalid data?
   → Show inline error vs. toast vs. block submit
   
2. User does things out of order?
   → Prevent vs. allow vs. guide back
   
3. User is halfway and closes the app?
   → Save draft vs. lose progress
   
4. User tries to do the same thing twice?
   → Allow vs. prevent duplicate
   
5. User doesn't have permission?
   → Hide feature vs. show disabled vs. show error
   
6. Network fails mid-action?
   → Retry vs. show error vs. queue for later
   
7. Action takes a long time?
   → Loading spinner vs. background process vs. estimated time
   
8. External system is down?
   → Graceful degradation vs. full block
```

### Format

```
**Edge Case: [Description]**

Scenario: User tries to [action] when [condition]

Options:
A) [Response 1] — Best UX, more complex
B) [Response 2] — Simple, but worse UX
C) [Response 3] — Defer to phase 2
D) Not relevant for MVP

Your preference?
```

---

## Business Logic Questions

### Rules Discovery

```
**Business Rules for [Feature]:**

Q1: Are there limits?
- Max items: ___
- Rate limits: ___
- Size limits: ___

Q2: Who can do what?
- All users can: ___
- Only [role] can: ___
- No one can: ___

Q3: What's the calculation/logic?
- Formula: ___
- Dependencies: ___
- Special cases: ___

Q4: What's the timing?
- Immediate
- Scheduled: ___
- After [event]: ___

Q5: What triggers notifications?
- Email when: ___
- In-app when: ___
- Push when: ___
```

---

## State Discovery

### For Each Entity

```
**Entity: [e.g., Order]**

Q1: What states can it be in?
A) [State 1] — meaning: ___
B) [State 2] — meaning: ___
C) [State 3] — meaning: ___
[List all]

Q2: What causes state changes?
- [State A] → [State B]: When ___
- [State B] → [State C]: When ___
[Map all transitions]

Q3: What can happen in each state?
- In [State A]: User can ___, system does ___
- In [State B]: User can ___, system does ___

Q4: What can't happen in each state?
- In [State A]: User cannot ___
- In [State B]: User cannot ___
```

---

## Integration Questions

### Third-Party Services

```
**Integration: [Service Name]**

Q1: What do we need from them?
A) Read data
B) Write data
C) Trigger actions
D) Receive webhooks

Q2: When does integration happen?
A) Real-time
B) Batch / scheduled
C) User-triggered
D) Event-triggered

Q3: What if they're unavailable?
A) Critical — block operation
B) Important — retry later
C) Nice-to-have — skip silently

Q4: Credentials/setup?
A) I have API keys
B) User connects their account
C) Need to apply for access
D) Not sure yet
```

---

## Priority Questions

### What First?

```
**If we could only ship ONE journey, which?**
A) [Journey 1]
B) [Journey 2]
C) [Journey 3]

**What's absolutely required for launch?**
[List must-haves]

**What can wait for v2?**
[List nice-to-haves]

**What's explicitly NOT being built?**
[List out-of-scope]
```

---

## Question Output

After all questions, I can fill:

```markdown
## PROJECT_AUDIT.md

✓ Problem understood
✓ User persona defined
✓ Primary journey mapped (step by step)
✓ Edge cases identified
✓ Business rules captured
✓ Entity states defined
✓ Integrations listed
✓ Priority clear
✓ Out of scope defined

→ Ready to proceed
```

If ANY section is incomplete: **Ask more questions.**
