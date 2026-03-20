# UX Ergonomics — Research-Backed Component Placement & Layout

## Core Principle

Every layout decision must be justified by UX research, eye-tracking data, or proven
patterns from high-converting products. No aesthetic guesses. Data drives placement.

---

## The F-Pattern & Z-Pattern (Eye-Tracking Research)

Nielsen Norman Group eye-tracking studies on 232 users show reading follows predictable
paths. Use this to place your most important content.

### F-Pattern (content-heavy pages: dashboards, feeds, lists)
```
████████████████████  ← Full scan (headline, hero, nav)
████████████
█████                 ← Second scan (subheading, key info)
████
█                     ← Vertical scan (left edge — labels, icons)
█
```
**Rule:** Critical actions and labels go LEFT. Supporting info goes right.
Primary CTA must fall in the first two horizontal bands.

### Z-Pattern (landing pages, auth screens, sparse pages)
```
START ──────────────► POINT 2
         ↙
POINT 3 ──────────► END/CTA
```
**Rule:** Logo top-left, trust signal top-right, value prop mid-left,
CTA bottom-right. This is why every SaaS landing page looks similar — it works.

---

## Competitor-Derived Component Placement

Research-backed positions from analysis of top products in each category:

### SaaS Dashboard (Notion, Linear, Figma, Vercel)
```
┌─────────────────────────────────────────────────────┐
│ LOGO   NAV ITEMS (left)              USER AVATAR (R) │  ← Top nav: 56-64px height
├──────────┬──────────────────────────────────────────┤
│          │  PAGE TITLE + BREADCRUMB                  │  ← Context bar: 48px
│  SIDE    ├──────────────────────────────────────────┤
│  NAV     │  PRIMARY METRIC CARDS (3-4 wide)          │  ← Key numbers: above fold
│  240px   │                                           │
│          │  MAIN CONTENT AREA                        │  ← 60% of viewport
│  (items  │  (table / chart / list)                   │
│  grouped │                                           │
│  by      ├────────────────────┬──────────────────────┤
│  context)│  SECONDARY TABLE   │  ACTIVITY FEED       │  ← Below fold: details
│          │  or CHART          │  (right panel 320px) │
└──────────┴────────────────────┴──────────────────────┘
```

**Research findings:**
- Left nav: users scan top-to-bottom. Most used items must be in top 5 slots.
- Metric cards: 3 is optimal (Gestalt law of proximity). 4 max before cognitive overload.
- Activity feed right: passive info lives right. Active tasks live left/center.
- Search: top-center or top-left. Never buried. Keyboard shortcut (⌘K) mandatory.

### E-Commerce / Marketplace (Amazon, Flipkart, Meesho research)
```
┌─────────────────────────────────────────────────────┐
│  LOGO   SEARCH BAR (center, 40% width)   CART/USER  │
├──────────┬──────────────────────────────────────────┤
│ FILTERS  │  SORT BAR (top-right of results)          │
│ (left    │  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐    │
│ sidebar  │  │      │ │      │ │      │ │      │    │
│ 220px,   │  │ CARD │ │ CARD │ │ CARD │ │ CARD │    │
│ sticky)  │  │      │ │      │ │      │ │      │    │
│          │  └──────┘ └──────┘ └──────┘ └──────┘    │
│ Price    │   Image top, name, rating, price, CTA     │
│ Rating   │                                           │
│ Category │  LOAD MORE / PAGINATION (bottom center)   │
└──────────┴────────────────────────────────────────── ┘
```

**Research findings (Baymard Institute, 2023 — 87,000 hours of UX research):**
- Filters left: 76% of users look left first for filters
- Search bar center/prominent: reduces bounce by 43% for product pages
- Product card: image must be ≥60% of card height. Price below image, not beside.
- CTA ("Add to cart") must be visible without scrolling the card
- Star ratings shown on card: increases CTR by 15-25%

### Mobile App (Thumb Zone Research — Steven Hoober, 1333 observations)
```
         ┌─────────┐
    HARD  │ ░░░░░░░ │  HARD    ← Thumb can't reach top corners easily
   REACH  │░░░░░░░░░│  REACH
          │ ░░░░░░░ │
    OK    │         │  OK      ← Middle zone: reachable but awkward
    ZONE  │  ███████│
          │ ████████│
   EASY   │█████████│  EASY    ← Bottom 40% of screen: natural thumb zone
   ZONE   │█████████│  ZONE
          │█████████│
          └─────────┘
           ← 49% hold phone one-handed (right thumb dominant)
```

**Rules derived:**
- Primary CTA (buy, submit, confirm): bottom center or bottom-right
- Tab bar: bottom, not top (iOS/Android both confirm this)
- Destructive actions (delete): top area — requires deliberate reach (prevents accidents)
- FAB (floating action button): bottom-right, 56px diameter minimum
- Navigation: bottom tab bar, max 5 items, current item highlighted

### B2B / Admin Tool (Stripe Dashboard, AWS Console, Retool patterns)
```
┌──────────────────────────────────────────────────────┐
│ PRODUCT NAME    ENVIRONMENT BADGE    SEARCH    AVATAR │
├───────┬──────────────────────────────────────────────┤
│       │ BREADCRUMB > Path > Current                   │
│ LEFT  ├──────────────────────────────────────────────┤
│ NAV   │ TITLE                          [PRIMARY BTN]  │
│       │ Subtitle / description                        │
│ (icon ├──────────────────────────────────────────────┤
│ +     │                                               │
│ label)│   DATA TABLE with inline actions              │
│       │   (sortable columns, row selection,           │
│ 64px  │    bulk actions appear on select)             │
│ wide  │                                               │
│ when  ├──────────────────────────────────────────────┤
│ coll- │ PAGINATION                    Showing X of Y  │
│ apsed)│                                               │
└───────┴──────────────────────────────────────────────┘
```

---

## Spacing & Sizing System (8-Point Grid)

All spacing must be multiples of 8px. This is used by Google, Apple, Airbnb, Shopify.

```
4px  — micro gaps (icon to label, badge padding)
8px  — tight spacing (list item internal padding)
16px — default spacing (card padding, form field gaps)
24px — section spacing (between related groups)
32px — major section breaks
48px — between distinct page sections
64px — hero/large section padding
```

Typography scale (based on Major Third ratio — 1.250):
```
10px — legal/micro
12px — caption, label, timestamp
14px — body small, table data
16px — body default (minimum for readability)
20px — body large, card title
24px — section heading (h3)
32px — page heading (h2)
40px — display small (h1)
48px — display large (hero)
```

---

## Color & Contrast (WCAG 2.1 AA minimum)

- Body text on background: ≥4.5:1 contrast ratio
- Large text (18px+ or 14px+ bold): ≥3:1
- Interactive elements (buttons, links): ≥3:1 against adjacent colors
- Never use color as the ONLY differentiator (colorblindness affects 8% of men)

Primary action color: must be distinct from body text and background.
Destructive action: red (#DC2626 or equivalent) — universally understood.
Success: green (#16A34A). Warning: amber (#D97706). Info: blue (#2563EB).

---

## Competitor-Derived Patterns by Feature

### Search
- Trigger: click OR ⌘K / Ctrl+K (keyboard shortcut mandatory for desktop)
- Placeholder: "Search [product noun]..." not just "Search..."
- Show recent searches when empty
- Fuzzy match + highlight matched characters in results
- Source: Algolia UX research + Linear, Notion, GitHub patterns

### Forms
- One column layout (Baymard: two-column forms confuse completion order)
- Label above field (not placeholder-as-label — vanishes on type)
- Inline validation on blur, not on every keystroke
- Primary CTA at bottom of form, secondary (cancel) to its left
- Progress indicator for multi-step forms (Krug, "Don't Make Me Think")

### Data Tables
- Column headers: left-align text, right-align numbers (universal reading convention)
- Row height: 40-48px for data-dense, 56-64px for touch/primary interfaces
- Sticky header on scroll
- Empty state: illustrative, not just "No data found"
- Bulk select: checkbox column left, bulk action bar appears on selection

### Notifications & Toasts
- Position: top-right desktop, bottom-center mobile
- Duration: 4s for info/success, 8s for warnings, persist for errors
- Max 3 visible at once (stack older ones)
- Source: Material Design + Apple HIG research

---

## Accessibility Baseline (non-negotiable)

Every frontend must pass these before shipping:
- [ ] All interactive elements keyboard-navigable (Tab order logical)
- [ ] Focus indicator visible (don't remove outline without custom style)
- [ ] Images have alt text
- [ ] Form fields have associated labels (not just placeholder)
- [ ] Color contrast ≥4.5:1 for body text
- [ ] Touch targets ≥44x44px (Apple HIG) / ≥48x48dp (Material)
- [ ] Screen reader tested (VoiceOver / NVDA)
