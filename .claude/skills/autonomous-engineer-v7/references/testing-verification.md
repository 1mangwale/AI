# Testing, Validation & Verification

## Table of Contents

1. [Core Philosophy](#the-core-philosophy)
2. [The Full Testing Pyramid](#the-full-testing-pyramid)
3. [The Action → Reaction Law](#the-action--reaction-law)
4. [Human Journey Testing](#human-journey-testing)
5. [Journey Templates by Tech Stack](#journey-templates-by-tech-stack)
   - [Web App Journeys (Playwright)](#web-app-journeys-playwright)
   - [Mobile App Journeys (Detox / Maestro)](#mobile-app-journeys-detox--maestro)
   - [API / Microservice Journeys (Supertest)](#api--microservice-journeys-supertest)
   - [Data Pipeline Journeys (pytest)](#data-pipeline-journeys-pytest)
6. [Cross-Layer Coexistence Testing](#cross-layer-coexistence-testing)
7. [The BUILD → TEST → VERIFY Loop](#the-build--test--verify-loop)
8. [Unit Test Templates (Jest / pytest)](#test-templates-by-layer)
9. [Integration Test Templates (Testcontainers)](#integration-test-testcontainers--real-db)
10. [API Test Templates (Supertest)](#api-test-supertestevery-endpoint-every-code)
11. [Verification Checklist](#verification-checklist-attach-to-every-code-block)
12. [Performance Testing (k6 / Lighthouse)](#performance-testing)
13. [Coverage Targets](#test-coverage-targets)
14. [Testing Rules Summary](#testing-rule-summary)

---


## The Core Philosophy

**Testing is not optional. It is not a phase that comes after building. It is part of building.**

Every action in a system has an equal and opposite reaction somewhere. A user clicks
"place order" → the order row appears in DB → inventory decrements → a confirmation
email queues → the UI shows "Order confirmed". Every single one of those reactions
must be verified. If any link in that chain is broken, the feature is broken — even
if the individual pieces look fine in isolation.

The goal is not coverage numbers. The goal is **confidence that the system behaves
correctly as a whole, the way a real human using it would experience it.**

---

## The Full Testing Pyramid

```
                    ┌─────────────────┐
                    │   HUMAN JOURNEY │  ← Does a real person experience the right thing?
                    │   (E2E / Playwright)│   Every critical path. Every persona.
                    └────────┬────────┘
                    ┌────────┴────────┐
                    │  BEHAVIOUR      │  ← Does the system keep its promises?
                    │  (API contract) │   Action → verify reaction. Every endpoint.
                    └────────┬────────┘
                    ┌────────┴────────┐
                    │  INTEGRATION    │  ← Does it work with real DB / real services?
                    │  (Testcontainers│   Not mocks. Real containers. Real data.
                    └────────┬────────┘
                    ┌────────┴────────┐
                    │  UNIT           │  ← Does the logic work in isolation?
                    │  (Jest/pytest)  │   Pure functions. No I/O.
                    └─────────────────┘

ALSO: Performance · Accessibility · Security · Coexistence · Voice
```

---

## The Action → Reaction Law

**Every write operation must have a verifiable reaction. Every reaction must be tested.**

Before writing any feature, map its reaction chain:

```
ACTION                      REACTIONS (all must be tested)
──────────────────────────────────────────────────────────────
User creates account    →   row in users table
                        →   row in subscriptions (free tier)
                        →   welcome email queued
                        →   audit log entry
                        →   UI shows onboarding screen
                        →   /api/users/me returns correct data

User places order       →   row in orders table (status: pending)
                        →   inventory.quantity decremented
                        →   order_items rows created
                        →   payment intent created
                        →   confirmation email queued
                        →   audit log entry
                        →   UI shows "Order placed"
                        →   GET /api/orders returns new order

Payment succeeds        →   order.status → 'confirmed'
                        →   invoice created
                        →   fulfillment job queued
                        →   UI shows "Payment confirmed"
                        →   webhook acknowledged 200

User deletes account    →   user.status → 'deleted'
                        →   session tokens invalidated
                        →   PII anonymised (GDPR)
                        →   all API calls return 401
                        →   UI redirects to login
```

**Rule:** Write the reaction map before writing the feature.
Test every reaction. Not just the main one.

---

## Human Journey Testing

A "human journey" test does not test an endpoint. It tests a **person trying to
accomplish something** — the way a real user actually uses the product.

### What makes a good journey test

```
BAD:  "POST /api/orders returns 201"        ← tests an endpoint
GOOD: "First-time user buys a product"      ← tests a human experience

BAD:  "Dashboard renders without errors"    ← tests rendering
GOOD: "Manager reviews team performance"    ← tests a person's goal
```

### Journey test structure (every journey)

```typescript
test('[PERSONA] can [GOAL] and [OBSERVABLE OUTCOME]', async ({ page }) => {
  // 1. SETUP — realistic starting state
  // 2. PERSONA — who is this person? what do they know? what device?
  // 3. STEPS — natural actions, not implementation-aware clicks
  // 4. REACTIONS — verify everything that should have changed
  //    - UI shows the right thing
  //    - DB has the right data
  //    - Emails/notifications queued
  //    - Audit log written
  //    - No other data contaminated
});
```

### Core personas to test for every product

| Persona | First action | What they care about |
|---------|-------------|---------------------|
| **New user** | Lands on homepage | Can I understand this? Can I sign up? |
| **Returning user** | Returns after 2 weeks | Is my data still there? Can I pick up where I left off? |
| **Power user** | Keyboard shortcuts | Can I do things fast? |
| **Error-prone user** | Submits bad data | Does the system guide me or punish me? |
| **Slow network user** | 3G throttled | Does it feel broken or just slow? |
| **Screen reader user** | Tab navigation | Can I use this without a mouse? |
| **Admin** | Manages other users | Can I see what I need? Can I not see what I shouldn't? |
| **Concurrent user** | Two tabs open | Does the second tab see stale state? |

---

## Journey Templates by Tech Stack

### Web App Journeys (Playwright)

```typescript
// tests/journeys/new-user-onboarding.journey.ts
import { test, expect } from '@playwright/test';
import { db } from '../helpers/db';

test('new user signs up, completes onboarding, and places first order', async ({ page }) => {
  const email = `test-${Date.now()}@example.com`;

  // ── SIGN UP ──────────────────────────────────────────
  await page.goto('/');
  await page.getByRole('link', { name: 'Get started' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('Secure123!');
  await page.getByRole('button', { name: 'Create account' }).click();

  // REACTION: welcome screen shown
  await expect(page.getByTestId('welcome-heading')).toBeVisible();

  // REACTION: user row created in DB
  const user = await db.query('SELECT * FROM users WHERE email = $1', [email]);
  expect(user.rows).toHaveLength(1);
  expect(user.rows[0].status).toBe('active');

  // REACTION: free subscription created
  const sub = await db.query(
    'SELECT * FROM subscriptions WHERE user_id = $1', [user.rows[0].id]
  );
  expect(sub.rows[0].plan_id).toBe('free');

  // REACTION: welcome email queued
  const jobs = await db.query(
    "SELECT * FROM job_queue WHERE type = 'email.welcome' AND payload->>'userId' = $1",
    [user.rows[0].id]
  );
  expect(jobs.rows).toHaveLength(1);

  // ── COMPLETE ONBOARDING ──────────────────────────────
  await page.getByLabel('Your name').fill('Test User');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('dashboard')).toBeVisible();

  // ── PLACE FIRST ORDER ────────────────────────────────
  await page.getByTestId('product-card').first().click();
  await page.getByRole('button', { name: 'Add to cart' }).click();
  await page.getByRole('link', { name: 'Cart (1)' }).click();
  await page.getByRole('button', { name: 'Checkout' }).click();
  await page.getByLabel('Card number').fill('4242424242424242');
  await page.getByLabel('Expiry').fill('12/28');
  await page.getByLabel('CVC').fill('123');
  await page.getByRole('button', { name: 'Pay' }).click();

  // REACTION: confirmation screen
  await expect(page.getByTestId('order-confirmation')).toBeVisible();

  // REACTION: order in DB with correct status
  const order = await db.query(
    'SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
    [user.rows[0].id]
  );
  expect(order.rows[0].status).toBe('confirmed');

  // REACTION: audit log written
  const audit = await db.query(
    "SELECT * FROM system_actions WHERE actor_id = $1 AND action_type = 'order.created'",
    [user.rows[0].id]
  );
  expect(audit.rows).toHaveLength(1);
});

test('error-prone user submits invalid data and gets helpful guidance', async ({ page }) => {
  await page.goto('/register');

  // Submit empty form
  await page.getByRole('button', { name: 'Create account' }).click();

  // REACTION: inline errors, not page redirect
  await expect(page.getByText('Email is required')).toBeVisible();
  await expect(page.getByText('Password is required')).toBeVisible();
  // REACTION: user is still on the same page
  await expect(page).toHaveURL('/register');

  // Submit invalid email
  await page.getByLabel('Email').fill('notanemail');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText('Enter a valid email address')).toBeVisible();

  // Submit weak password
  await page.getByLabel('Email').fill('valid@example.com');
  await page.getByLabel('Password').fill('123');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText('Password must be at least 8 characters')).toBeVisible();
});

test('concurrent user sees consistent state across two tabs', async ({ browser }) => {
  const ctx = await browser.newContext();
  const tab1 = await ctx.newPage();
  const tab2 = await ctx.newPage();

  await tab1.goto('/dashboard');
  await tab2.goto('/dashboard');

  // Action in tab1
  await tab1.getByRole('button', { name: 'Create item' }).click();
  await tab1.getByLabel('Name').fill('New Item');
  await tab1.getByRole('button', { name: 'Save' }).click();

  // REACTION: tab1 sees new item immediately
  await expect(tab1.getByText('New Item')).toBeVisible();

  // REACTION: tab2 reflects change (websocket or on next action)
  await tab2.reload();
  await expect(tab2.getByText('New Item')).toBeVisible();

  await ctx.close();
});
```

### Mobile App Journeys (Detox / Maestro)

```yaml
# tests/journeys/mobile-first-launch.yaml  (Maestro syntax)
appId: com.yourapp.mobile

---
- launchApp:
    clearState: true

# PERSONA: first-time user, fresh install
- assertVisible: "Welcome to [App]"
- assertVisible: "Get Started"

# Onboarding flow
- tapOn: "Get Started"
- assertVisible: "Enter your mobile number"
- inputText:
    id: phone-input
    text: "+91 98765 43210"
- tapOn: "Send OTP"

# REACTION: OTP screen shown
- assertVisible: "Enter the 6-digit code"

# REACTION: (check in test DB that OTP was created)
- runScript: verify-otp-created.js

# Enter OTP
- inputText:
    id: otp-input
    text: "123456"  # seeded test OTP
- tapOn: "Verify"

# REACTION: home screen shown (not login)
- assertVisible: "Home"
- assertNotVisible: "Login"

# REACTION: auth token stored securely
- runScript: verify-secure-token-stored.js
```

```javascript
// tests/journeys/mobile-first-launch.journey.test.js  (Detox)
describe('First-time user journey', () => {
  beforeAll(async () => {
    await device.launchApp({ newInstance: true, delete: true });
  });

  it('completes onboarding and reaches home screen', async () => {
    await expect(element(by.id('welcome-screen'))).toBeVisible();
    await element(by.id('get-started-btn')).tap();
    await element(by.id('phone-input')).typeText('+919876543210');
    await element(by.id('send-otp-btn')).tap();
    await expect(element(by.id('otp-screen'))).toBeVisible();
    await element(by.id('otp-input')).typeText('123456');
    await element(by.id('verify-btn')).tap();
    // REACTION: home screen, not login
    await expect(element(by.id('home-screen'))).toBeVisible();
    await expect(element(by.id('login-screen'))).not.toBeVisible();
  });

  it('remembers user on app restart', async () => {
    await device.reloadReactNative();
    // REACTION: goes straight to home, not onboarding
    await expect(element(by.id('home-screen'))).toBeVisible();
    await expect(element(by.id('welcome-screen'))).not.toBeVisible();
  });
});
```

### API / Microservice Journeys (Supertest — full lifecycle)

```typescript
// tests/journeys/order-lifecycle.journey.ts
// Tests the FULL lifecycle of an order across all services
// Not individual endpoints — the complete state machine

import request from 'supertest';
import { app } from '../../src/app';
import { db } from '../helpers/db';
import { seedUser, seedProduct } from '../helpers/seed';

describe('Order lifecycle journey', () => {
  let authToken: string;
  let userId: string;
  let productId: string;
  let orderId: string;

  beforeAll(async () => {
    ({ authToken, userId } = await seedUser());
    ({ productId } = await seedProduct({ stock: 10 }));
  });

  it('1. user browses products and sees stock', async () => {
    const res = await request(app)
      .get(`/api/products/${productId}`)
      .set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.stockCount).toBe(10);
  });

  it('2. user places order — all reactions fire', async () => {
    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ items: [{ productId, quantity: 2 }] });

    expect(res.status).toBe(201);
    orderId = res.body.data.id;

    // REACTION 1: order row exists with correct status
    const order = await db.query('SELECT * FROM orders WHERE id=$1', [orderId]);
    expect(order.rows[0].status).toBe('pending');
    expect(order.rows[0].user_id).toBe(userId);

    // REACTION 2: stock decremented
    const product = await db.query('SELECT stock_count FROM products WHERE id=$1', [productId]);
    expect(product.rows[0].stock_count).toBe(8); // 10 - 2

    // REACTION 3: order_items created
    const items = await db.query('SELECT * FROM order_items WHERE order_id=$1', [orderId]);
    expect(items.rows).toHaveLength(1);
    expect(items.rows[0].quantity).toBe(2);

    // REACTION 4: audit log written
    const audit = await db.query(
      "SELECT * FROM system_actions WHERE entity_id=$1 AND action_type='order.created'",
      [orderId]
    );
    expect(audit.rows).toHaveLength(1);

    // REACTION 5: email job queued
    const job = await db.query(
      "SELECT * FROM job_queue WHERE type='email.order_confirmation' AND payload->>'orderId'=$1",
      [orderId]
    );
    expect(job.rows).toHaveLength(1);
  });

  it('3. payment webhook arrives — state machine advances', async () => {
    const res = await request(app)
      .post('/api/webhooks/payment')
      .set('stripe-signature', generateTestSignature({ orderId, status: 'paid' }))
      .send({ type: 'payment_intent.succeeded', data: { orderId } });

    expect(res.status).toBe(200); // must ack webhook

    // REACTION 1: order status advanced
    const order = await db.query('SELECT status FROM orders WHERE id=$1', [orderId]);
    expect(order.rows[0].status).toBe('confirmed');

    // REACTION 2: fulfillment job queued
    const job = await db.query(
      "SELECT * FROM job_queue WHERE type='fulfillment.start' AND payload->>'orderId'=$1",
      [orderId]
    );
    expect(job.rows).toHaveLength(1);
  });

  it('4. user cancels — stock is restored', async () => {
    // Create a separate order to cancel
    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ items: [{ productId, quantity: 1 }] });
    const cancelOrderId = res.body.data.id;

    await request(app)
      .post(`/api/orders/${cancelOrderId}/cancel`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200);

    // REACTION: stock restored
    const product = await db.query('SELECT stock_count FROM products WHERE id=$1', [productId]);
    expect(product.rows[0].stock_count).toBe(7); // 8 - 1 + 1 (cancel restores)

    // REACTION: order status is cancelled
    const order = await db.query('SELECT status FROM orders WHERE id=$1', [cancelOrderId]);
    expect(order.rows[0].status).toBe('cancelled');
  });

  it('5. cannot place order for out-of-stock product', async () => {
    await db.query('UPDATE products SET stock_count=0 WHERE id=$1', [productId]);
    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ items: [{ productId, quantity: 1 }] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('OUT_OF_STOCK');
  });
});
```

### Data Pipeline Journeys (pytest — end-to-end data correctness)

```python
# tests/journeys/test_pipeline_data_correctness.py
# Tests that data flows correctly through every stage of the pipeline

import pytest
from datetime import date, timedelta
from src.pipeline import run_pipeline
from tests.helpers import seed_raw_events, query_processed, query_aggregates

class TestPipelineJourney:
    """
    Full journey: raw event → processed → aggregated → correct numbers
    Every transformation must produce verifiable, correct output.
    """

    def test_event_flows_through_all_stages(self, test_db):
        # SEED: known raw events
        seed_raw_events(test_db, [
            {'user_id': 'u1', 'event': 'purchase', 'amount': 100, 'ts': '2024-01-15 10:00'},
            {'user_id': 'u1', 'event': 'purchase', 'amount': 200, 'ts': '2024-01-15 14:00'},
            {'user_id': 'u2', 'event': 'purchase', 'amount': 150, 'ts': '2024-01-15 11:00'},
        ])

        # ACTION: run pipeline for that date
        run_pipeline(date(2024, 1, 15))

        # REACTION 1: all events processed (none lost)
        processed = query_processed(test_db, date(2024, 1, 15))
        assert len(processed) == 3

        # REACTION 2: aggregates correct
        agg = query_aggregates(test_db, date=date(2024, 1, 15))
        assert agg['total_revenue'] == 450   # 100+200+150
        assert agg['unique_users'] == 2
        assert agg['transaction_count'] == 3

        # REACTION 3: pipeline run logged
        run_log = test_db.query(
            "SELECT * FROM pipeline_runs WHERE run_date='2024-01-15'"
        )
        assert run_log[0]['status'] == 'success'
        assert run_log[0]['record_count'] == 3

    def test_pipeline_is_idempotent(self, test_db):
        """Running the same pipeline twice must produce identical results."""
        seed_raw_events(test_db, [
            {'user_id': 'u1', 'event': 'purchase', 'amount': 500, 'ts': '2024-01-16 10:00'},
        ])

        run_pipeline(date(2024, 1, 16))
        run_pipeline(date(2024, 1, 16))  # run again — same result, not doubled

        agg = query_aggregates(test_db, date=date(2024, 1, 16))
        assert agg['total_revenue'] == 500   # NOT 1000
        assert agg['transaction_count'] == 1  # NOT 2

    def test_bad_data_does_not_corrupt_good_data(self, test_db):
        """One malformed event must not break the entire batch."""
        seed_raw_events(test_db, [
            {'user_id': 'u1', 'event': 'purchase', 'amount': 100, 'ts': '2024-01-17 10:00'},
            {'user_id': None, 'event': 'purchase', 'amount': 'bad', 'ts': 'invalid'},  # corrupt
            {'user_id': 'u2', 'event': 'purchase', 'amount': 200, 'ts': '2024-01-17 12:00'},
        ])

        run_pipeline(date(2024, 1, 17))

        # Good events processed
        agg = query_aggregates(test_db, date=date(2024, 1, 17))
        assert agg['total_revenue'] == 300  # 100+200 only

        # Bad event logged as rejected, not silently dropped
        rejected = test_db.query(
            "SELECT * FROM pipeline_rejected WHERE run_date='2024-01-17'"
        )
        assert len(rejected) == 1
```

---

## Cross-Layer Coexistence Testing

Tests that verify all layers of the system behave correctly **together**, not just in isolation.

### The Coexistence Matrix

For every feature, fill this matrix and test every cell:

```
FEATURE: "User places order"

                  DB correct?   API correct?   UI correct?   Audit logged?   Email queued?
                  ──────────────────────────────────────────────────────────────────────────
Happy path        ✓ test it     ✓ test it      ✓ test it     ✓ test it       ✓ test it
Invalid input     ✓ not written ✓ 400 returned ✓ error shown ✓ not written   ✓ not queued
Network timeout   ✓ not written ✓ 504 returned ✓ shows retry —               —
Duplicate submit  ✓ once only   ✓ 200 (idem)   ✓ no double   ✓ once only     ✓ once only
Concurrent users  ✓ no race     ✓ consistent   ✓ consistent  ✓ both logged   ✓ both queued
Auth expired      ✓ not written ✓ 401          ✓ redirected  —               —
```

Every ✓ in that matrix is a test case. Every empty cell is a known gap.

### Coexistence Test Template

```typescript
// tests/coexistence/order-placement.coexistence.ts

describe('Order placement — full system coexistence', () => {

  describe('Happy path — all layers agree', () => {
    it('creates order in DB AND returns correct API response AND shows in UI', async () => {
      const res = await placeOrder(authToken, validOrderPayload);
      const orderId = res.body.data.id;

      // All layers must agree
      expect(res.status).toBe(201);                             // API layer
      await expect(db.order(orderId)).resolves.toMatchObject({  // DB layer
        status: 'pending', userId
      });
      await expect(page.getByTestId('order-id')).toHaveText(orderId); // UI layer
      await expect(db.auditLog(orderId)).resolves.toHaveLength(1);    // Audit layer
    });
  });

  describe('Duplicate submission — idempotency', () => {
    it('second identical request produces ONE order, not two', async () => {
      const idempotencyKey = 'test-key-' + Date.now();
      const place = () => request(app)
        .post('/api/orders')
        .set('Idempotency-Key', idempotencyKey)
        .set('Authorization', `Bearer ${authToken}`)
        .send(validOrderPayload);

      const [res1, res2] = await Promise.all([place(), place()]);

      // Both return success
      expect(res1.status).toBe(201);
      expect(res2.status).toBe(201);

      // But only ONE order in DB
      const orders = await db.query(
        'SELECT * FROM orders WHERE user_id=$1 AND created_at > NOW()-INTERVAL \'5 seconds\'',
        [userId]
      );
      expect(orders.rows).toHaveLength(1); // NOT 2
    });
  });

  describe('Concurrent stock depletion — no overselling', () => {
    it('10 concurrent orders for stock=5 result in exactly 5 confirmed', async () => {
      await db.query('UPDATE products SET stock_count=5 WHERE id=$1', [productId]);
      const users = await Promise.all(Array.from({ length: 10 }, () => seedUser()));

      const results = await Promise.all(
        users.map(u => request(app)
          .post('/api/orders')
          .set('Authorization', `Bearer ${u.authToken}`)
          .send({ items: [{ productId, quantity: 1 }] })
        )
      );

      const confirmed = results.filter(r => r.status === 201);
      const rejected = results.filter(r => r.status === 409);

      expect(confirmed).toHaveLength(5);   // exactly 5 succeed
      expect(rejected).toHaveLength(5);    // exactly 5 fail
      // Stock is now 0, not negative
      const product = await db.query('SELECT stock_count FROM products WHERE id=$1', [productId]);
      expect(product.rows[0].stock_count).toBe(0);
    });
  });
});
```

---

## The BUILD → TEST → VERIFY Loop

Every piece of code goes through this — in order, no skipping:

```
WRITE code
  → STATIC:      typecheck + lint (tsc --noEmit && eslint)
  → UNIT:        pure logic works in isolation (jest / pytest)
  → INTEGRATION: works with real DB/services (testcontainers)
  → API:         every endpoint, every status code, every error
  → JOURNEY:     every human persona, every critical path
  → COEXISTENCE: action → all reactions correct simultaneously
  → PERFORMANCE: p95 latency within SLO (k6)
  → ACCESSIBILITY: 0 critical issues (axe-core / Playwright axe)
  → VERIFY:      checklist signed off
```

Mark any skipped step as explicitly deferred with a reason. Never silently omit.

---

## Test Templates by Layer

### Unit Test (TypeScript/Jest)

```typescript
// tests/unit/order.service.test.ts
// Pure logic — no DB, no HTTP, no external calls

import { OrderService } from '../../src/modules/orders/order.service';
import { createMockRepository } from '../helpers/mock-repository';

describe('OrderService', () => {
  let service: OrderService;
  let mockRepo: ReturnType<typeof createMockRepository>;

  beforeEach(() => {
    mockRepo = createMockRepository();
    service = new OrderService(mockRepo, mockConfigService());
  });

  it('calculates total correctly including tax from config', async () => {
    const order = await service.createOrder({
      userId: 'u1',
      items: [{ productId: 'p1', quantity: 2, unitPriceCents: 1000 }],
    });
    expect(order.subtotalCents).toBe(2000);
    expect(order.taxCents).toBeGreaterThan(0);          // tax from config, not hardcoded
    expect(order.totalCents).toBe(order.subtotalCents + order.taxCents);
  });

  it('rejects order with zero items', async () => {
    await expect(service.createOrder({ userId: 'u1', items: [] }))
      .rejects.toThrow('Order must contain at least one item');
  });

  it('rejects when user does not exist', async () => {
    mockRepo.users.findById.mockResolvedValue(null);
    await expect(service.createOrder({ userId: 'ghost', items: [{ productId: 'p1', quantity: 1, unitPriceCents: 100 }] }))
      .rejects.toThrow('User not found');
  });
});
```

### Integration Test (Testcontainers — real DB)

```typescript
// tests/integration/order.repository.test.ts

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { OrderRepository } from '../../src/modules/orders/order.repository';
import { runMigrations } from '../helpers/migrate';

describe('OrderRepository', () => {
  let container: StartedPostgreSqlContainer;
  let repo: OrderRepository;

  beforeAll(async () => {
    container = await new PostgreSqlContainer().start();
    await runMigrations(container.getConnectionUri());
    repo = new OrderRepository(container.getConnectionUri());
  });
  afterAll(() => container.stop());

  it('creates and retrieves', async () => {
    const created = await repo.create({ userId: 'u1', totalCents: 5000 });
    const found = await repo.findById(created.id);
    expect(found).toMatchObject({ id: created.id, totalCents: 5000 });
  });

  it('cursor-paginates without overlap', async () => {
    await Promise.all(Array.from({ length: 25 }, (_, i) =>
      repo.create({ userId: 'u1', totalCents: i * 100 })
    ));
    const page1 = await repo.list({ userId: 'u1', limit: 10, cursor: null });
    const page2 = await repo.list({ userId: 'u1', limit: 10, cursor: page1.nextCursor });
    const ids1 = page1.items.map(o => o.id);
    const ids2 = page2.items.map(o => o.id);
    expect(ids1.filter(id => ids2.includes(id))).toHaveLength(0);
  });
});
```

### API Test (Supertest — every endpoint, every code)

```typescript
// tests/api/orders.api.test.ts

describe('POST /api/orders', () => {
  it('201 — valid input', async () => {
    const res = await request(app).post('/api/orders')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ items: [{ productId: 'prod-1', quantity: 1 }] });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      id: expect.any(String), status: 'pending', totalCents: expect.any(Number),
    });
  });
  it('400 — empty items',    () => expectStatus(400, { items: [] }));
  it('400 — missing fields', () => expectStatus(400, {}));
  it('401 — no auth',        () => expectStatusNoAuth(401, { items: [{ productId: 'x', quantity: 1 }] }));
  it('404 — product not found', () => expectStatus(404, { items: [{ productId: 'nonexistent', quantity: 1 }] }));
  it('409 — out of stock',   async () => {
    await db.query('UPDATE products SET stock_count=0 WHERE id=$1', ['prod-1']);
    const res = await request(app).post('/api/orders')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ items: [{ productId: 'prod-1', quantity: 1 }] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('OUT_OF_STOCK');
  });
});
```

### Python Unit Tests (pytest)

```python
import pytest
from unittest.mock import AsyncMock, MagicMock
from src.modules.orders.service import OrderService

@pytest.fixture
def service():
    repo = MagicMock()
    repo.create = AsyncMock(return_value={'id': 'order-1', 'total_cents': 2200})
    return OrderService(repository=repo)

@pytest.mark.asyncio
async def test_calculates_total_with_tax(service):
    result = await service.create_order(
        user_id='u1',
        items=[{'product_id': 'p1', 'quantity': 2, 'unit_price_cents': 1000}]
    )
    assert result['total_cents'] > 2000  # tax applied

@pytest.mark.asyncio
async def test_rejects_empty_items(service):
    with pytest.raises(ValueError, match='at least one item'):
        await service.create_order(user_id='u1', items=[])
```

---

## Verification Checklist (attach to every code block)

```
VERIFY:
[ ] Run:             [exact command — copy-paste ready]
[ ] Expected output: [what success looks like]
[ ] Error case:      [command] → [expected response]
[ ] DB reaction:     [query] → [expected row/value]
[ ] If fails:        [most likely cause + one-line fix]
[ ] Performance:     p95 < [Xms] under [Y concurrent users]
```

---

## Performance Testing

### k6 Load Test

```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: 20 },
    { duration: '1m',  target: 20 },
    { duration: '10s', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<500'],
    http_req_failed:   ['rate<0.01'],
  },
};

export default function () {
  const res = http.get('http://localhost:3000/api/health');
  check(res, { 'status is 200': r => r.status === 200 });
  sleep(1);
}
```

### Lighthouse CI

```yaml
- name: Lighthouse CI
  uses: treosh/lighthouse-ci-action@v10
  with:
    urls: http://localhost:3000
    budgetPath: lighthouse-budget.json
```

```json
[{ "path": "/*",
   "timings": [
     { "metric": "first-contentful-paint", "budget": 2000 },
     { "metric": "interactive", "budget": 3500 }
   ],
   "resourceSizes": [
     { "resourceType": "script", "budget": 300 },
     { "resourceType": "total",  "budget": 500 }
   ]
}]
```

---

## Test Coverage Targets

| Layer | Target | Tool |
|-------|--------|------|
| Domain logic (services) | 90%+ | Jest / pytest |
| Repository layer | 80%+ (integration) | Testcontainers |
| API endpoints | 100% of routes × all status codes | Supertest |
| Human journeys | 100% of critical paths × all personas | Playwright / Detox / Maestro |
| Coexistence (action→reaction) | 100% of write operations | Custom per feature |
| Performance SLOs | p95 < 500ms | k6 |
| Accessibility | 0 critical issues | axe-core |
| Data pipeline correctness | 100% of transforms | pytest |

Fail the build if coverage drops below target:
```json
{
  "coverageThreshold": {
    "global": { "branches": 80, "functions": 85, "lines": 85 }
  }
}
```

---

## Testing Rule Summary

1. **Every write has a reaction. Every reaction has a test.**
2. **Test personas, not endpoints.** Real people trying to accomplish real goals.
3. **Test coexistence.** API + DB + UI + audit must all agree simultaneously.
4. **Test the unhappy paths.** Error-prone users, bad data, timeouts, concurrent writes.
5. **Test idempotency.** Submitting twice must produce the same result as submitting once.
6. **Test state machines.** Every status transition must be tested: forward, blocked, and reversed.
7. **Never test implementation.** Test behaviour. The test should not break when you refactor internals.
8. **Journeys span the full stack.** A journey test that only checks the UI is half a test.
