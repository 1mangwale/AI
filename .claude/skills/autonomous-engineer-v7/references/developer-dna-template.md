# Developer DNA — Akash A Agarwal — v1 — [Date]

Paste this at the start of any new session for personalized experience.

---

## Stack Preferences

```yaml
# Backend
backend_framework: nestjs | laravel | express | fastapi | [other]
database: postgresql | mysql | mongodb | sqlite
orm: prisma | typeorm | eloquent | drizzle
queue: bullmq | redis | rabbitmq | sqs
cache: redis | memcached | none

# Frontend  
frontend_framework: nextjs | react | vue | svelte | [other]
styling: tailwind | css-modules | styled-components | vanilla
state_management: zustand | redux | jotai | context | [other]
ui_library: shadcn | radix | material | custom

# Mobile
mobile_framework: react-native | flutter | none
mobile_navigation: expo-router | react-navigation | go-router

# Infrastructure
hosting: vercel | railway | aws | gcp | self-hosted
ci_cd: github-actions | gitlab-ci | jenkins
monitoring: sentry | datadog | none
```

---

## Code Style

```yaml
# Naming
variable_naming: camelCase | snake_case
file_naming: kebab-case | camelCase | PascalCase
component_naming: PascalCase

# Structure
component_style: single-file | split-files
max_file_lines: 200 | 300 | 500
imports_style: absolute | relative

# Types
typescript_strictness: strict | normal | loose
prefer_interfaces: true | false
use_zod_validation: true | false

# Comments
comment_level: minimal | moderate | verbose
jsdoc_functions: true | false
```

---

## UI/UX Preferences

```yaml
# Visual
theme_preference: dark | light | system
aesthetic: minimal | bold | corporate | playful
density: spacious | balanced | compact
rounded_corners: none | sm | md | lg | full

# Motion
animation_level: none | subtle | moderate | expressive
page_transitions: true | false

# Components
button_style: solid | outline | ghost
card_style: flat | elevated | bordered
```

---

## Patterns I Like

```yaml
# Add patterns that worked well for you
- pattern: Repository pattern for data access
  reason: Clean separation, easy to test
  
- pattern: Server Actions in Next.js
  reason: Less boilerplate than API routes
  
- pattern: Zustand for state
  reason: Simple, no boilerplate
  
# Add more as you work...
```

---

## Patterns I Avoid

```yaml
# Add patterns you've rejected
- pattern: Redux for simple state
  reason: Too much boilerplate
  
- pattern: CSS-in-JS at runtime
  reason: Performance concerns
  
- pattern: Deeply nested folders
  reason: Hard to navigate
  
# Add more as you work...
```

---

## Architecture Decisions

```yaml
# Record decisions made
- decision: Use PostgreSQL over MongoDB
  reason: Relational data, ACID compliance
  date: YYYY-MM-DD

- decision: Monorepo with Turborepo
  reason: Shared code between web and mobile
  date: YYYY-MM-DD
  
# Add more as projects evolve...
```

---

## Communication Preferences

```yaml
verbosity: minimal | balanced | detailed
show_alternatives: always | when-relevant | never
ask_questions: batch | one-at-a-time | minimal
mockups: always | for-complex-ui | on-request
code_comments: minimal | key-sections | verbose
```

---

## Projects History

### [Project Name 1]
```yaml
date: YYYY-MM
stack: nextjs, prisma, postgresql
what_worked: 
  - Server components for data fetching
  - tRPC for type safety
what_id_change:
  - Would use Drizzle instead of Prisma for edge
learnings:
  - SSR + hydration needs careful handling
```

### [Project Name 2]
```yaml
# Add as you complete projects...
```

---

## Evolution Log

```
v1 [date]: Initial DNA created
v2 [date]: Added [learning] from [project]
v3 [date]: Updated [preference] based on [experience]
```

---

## Quick Reference (for Claude)

```yaml
# Summary of key preferences
stack: [main stack summary]
style: [code style summary]  
aesthetic: [UI preference summary]
communication: [how to interact]
```
