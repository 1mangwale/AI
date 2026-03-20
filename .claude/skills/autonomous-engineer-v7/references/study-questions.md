# Study Questions — Project Intake Checklist

Use this checklist during Phase 1. Extract answers from the user's description first.
Make reasonable assumptions for anything not stated. Document all assumptions explicitly.

## End Goal
- [ ] What is the primary user problem being solved?
- [ ] Who are the users? (internal team, consumers, developers, machines)
- [ ] What does "done" look like? What's the MVP vs full vision?
- [ ] What is the single most important metric for success?

## Technical Context
- [ ] Primary language(s)?
- [ ] Framework preferences or constraints?
- [ ] Existing infrastructure (cloud provider, DB already chosen, etc.)?
- [ ] Any services that must be integrated (auth, payments, messaging)?

## Scale & Quality Profile
- [ ] Expected daily active users (or requests/sec for APIs)?
- [ ] Data volume — how much data, how fast does it grow?
- [ ] Latency requirements (real-time, near-real-time, batch OK)?
- [ ] Availability requirements (99.9%? 99.99%?)?
- [ ] Geographic distribution needed?

## Team & Process
- [ ] Team size (solo, small team, large org)?
- [ ] CI/CD expectations?
- [ ] Monorepo or separate repos?

## Compliance & Security
- [ ] Handles PII or sensitive data?
- [ ] Regulatory requirements (GDPR, HIPAA, SOC2)?
- [ ] Authentication model (JWT, OAuth, API keys, SSO)?

---

## Default Assumptions (when not stated)

If the user doesn't specify, apply these defaults and note them:

| Concern | Default assumption |
|---------|-------------------|
| Language | Match what the user's first code snippet uses, else TypeScript |
| Database | PostgreSQL (relational default) |
| Auth | JWT with refresh tokens |
| Scale | Mid-scale: <10k DAU, <1k req/sec |
| Availability | 99.9% (allows ~8h downtime/year) |
| Cloud | AWS (most common), but keep cloud-agnostic |
| CI/CD | GitHub Actions |
| Containers | Docker + docker-compose for local, K8s for prod |
| Config | Environment variables + DB config table |
| Logging | Structured JSON logs, shipped to centralized store |
