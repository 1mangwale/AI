# Market Research — Competitor Analysis & Business Intelligence

## Why Market Research Before Code

The best architecture decisions come from understanding what already exists and why it
succeeded or failed. You build better when you know the terrain.

---

## Research Sequence

For every new project, run this sequence:

### Step 1: Category Origin
Search: `history of [product category]`, `first [product type] ever built`, `origin of [space]`

Answer:
- When did this category emerge?
- What was the original problem being solved?
- What was the MVP that proved the model?
- What inflection point made it mainstream?

This tells you what's table stakes vs what's still evolving.

### Step 2: Current Global Leaders
Search: `best [product type] 2025`, `top [product category] apps`, `[product type] market share`

For each leader:
- Where are they headquartered? (signals regulation awareness needed)
- Business model (freemium, SaaS, usage-based, marketplace)?
- What made them win?
- What do their 1-star reviews say? (That's the white space)

### Step 3: Regional & Emerging Players
Search: `[product type] India` / `[product type] Southeast Asia` / `[product type] Africa`
(adjust for the human's market)

Often the best patterns come from markets that had to solve the same problem with fewer
resources — those solutions are usually leaner and more elegant.

### Step 4: Open-Source Landscape
Search: `open source [product type]`, `self-hosted [product type]`, `github [product type]`

For each OSS option:
- GitHub stars + recent activity (last commit date)
- License (MIT, GPL, AGPL — matters for commercial use)
- Can it be used as a foundation or reference?
- Why did people build it instead of buying?

### Step 5: White Space Identification

Read the Market Map and ask:
1. What do ALL of them do poorly? → Primary white space
2. What do the LEADERS ignore? → Underserved segments
3. What do USERS keep asking for? → Check feature request boards, Reddit, Product Hunt comments
4. What's technically possible NOW that wasn't 2 years ago? → AI, voice, edge compute, etc.

---

## Market Map Template

```markdown
## Market Map: [Product Category]

**Category origin:** [year + brief story]
**Market size estimate:** [if findable]
**Growth trend:** [growing/stable/declining + signal]

### Global Leaders
| Product | HQ | Model | Monthly Users | Strengths | Weaknesses |
|---------|----|----|--------------|-----------|------------|
| | | | | | |

### Regional Players (relevant to target market)
| Product | Region | Differentiator |
|---------|--------|----------------|
| | | |

### Open-Source Options
| Repo | Stars | License | Last Active | Usable as base? |
|------|-------|---------|------------|-----------------|
| | | | | |

### White Space
1. [Gap 1] — none of the above do this well because [reason]
2. [Gap 2] — users keep asking for this (source: [review/forum])
3. [Gap 3] — technically possible now due to [new capability]

### Our Positioning
We win by: [specific thing we do that market map shows is a gap]
```

---

## Ongoing Competitive Intelligence

After the initial research, keep watching. At the start of each major build phase, do a
quick pulse check:

```
Search: "[top competitor] new feature" OR "[top competitor] changelog" (last 30 days)
Search: "[product category] news" (last 7 days)
```

If a competitor just shipped something significant that affects your build:
- Note it in the Project Brief under "Market developments"
- Assess whether it changes priorities
- Decide: adopt the pattern? differentiate? ignore?

---

## Business Model Intelligence

When the human describes their revenue model, map it to a standard pattern and note
the architectural implications:

| Model | Implication |
|-------|------------|
| **SaaS / subscription** | Usage metering table, billing webhooks, plan limits in DB config |
| **Marketplace** | Split payments, escrow logic, two-sided notifications, trust & safety |
| **Usage-based** | Event metering pipeline, real-time cost calculation, billing alerts |
| **Freemium** | Feature flags tied to plan tier, upgrade prompts, conversion tracking |
| **B2B / enterprise** | Multi-tenancy, SSO, audit logs, role-based access, SLAs |
| **Consumer / B2C** | Onboarding funnel, retention hooks, social features, push notifications |
| **API / platform** | Rate limiting, API key management, usage dashboards, webhook system |

Every business model has a corresponding set of **must-have tables**. Build them early.
