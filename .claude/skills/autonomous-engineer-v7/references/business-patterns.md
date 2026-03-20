# Business & Architecture Patterns (2026)

## Search First
```
Search: "[industry] startup trends 2026"
Search: "[product type] business model"
Search: "[competitor] pricing model"
```

---

## Revenue Models (What Works 2026)

| Model | When | Pricing | Example |
|-------|------|---------|---------|
| **Usage-based** | API, AI, infra | $X per unit | OpenAI, Twilio |
| **Seat + usage** | B2B SaaS | $Y/user + overage | Slack, Notion |
| **Freemium** | Consumer, PLG | Free tier → $Z/mo | Spotify, Figma |
| **Transaction fee** | Marketplace | X% per sale | Stripe, Shopify |
| **Tiered** | SaaS | Good/Better/Best | Most SaaS |

### Pricing Psychology
```
- Free tier: acquire users, prove value
- $10-20/mo: impulse buy, personal
- $50-100/mo: SMB, needs approval
- $500+/mo: Enterprise, procurement
```

---

## Architecture Trends 2026

### What's In
```
✓ AI-augmented (not AI-only)
✓ API-first, UI-second
✓ Edge computing (Cloudflare, Vercel Edge)
✓ Local-first with sync
✓ Event-driven / async
✓ Vertical SaaS (niche > horizontal)
✓ Composable (headless, APIs)
```

### What's Out
```
✗ Monoliths (modular wins)
✗ CRUD-only SaaS (AI eats this)
✗ Flat pricing (usage wins)
✗ Single-platform (web + mobile required)
✗ Manual anything (automate or die)
```

---

## Tech Stack Defaults

### Web App
```
Next.js 15 + tRPC + Tailwind + Prisma + PostgreSQL + Redis
Deploy: Vercel + Supabase or Railway
```

### API/Backend
```
NestJS + Prisma + PostgreSQL + BullMQ + Redis
Deploy: Railway or Render
```

### Mobile
```
React Native (Expo, New Arch) or Flutter 4
Backend: Same as API
```

### AI Features
```
Vercel AI SDK + OpenAI/Anthropic + pgvector
Prompts in DB, costs tracked
```

---

## Competitor Analysis (Quick)

```
1. Search: "[product type] competitors"
2. Identify top 5
3. For each:
   - Pricing model?
   - Core feature?
   - Weakness?
4. Find white space (what nobody does well)
5. Build toward the gap
```

---

## Validation Checklist

Before building:
```
□ Who pays? (not who uses)
□ How much? (check competitor pricing)
□ Why now? (AI, regulation, behavior shift)
□ Why you? (unfair advantage)
□ Can it scale? (unit economics)
```

---

## Metrics That Matter

| Stage | Focus Metric |
|-------|--------------|
| Pre-launch | Waitlist signups |
| Launch | Activation rate |
| Growth | Retention (D7, D30) |
| Scale | LTV:CAC ratio |
| Mature | Net revenue retention |

---

## Common Mistakes

```
✗ Building before validating
✗ Too many features at launch
✗ Pricing too low
✗ Ignoring mobile
✗ Not tracking costs
✗ Manual ops at scale
```
