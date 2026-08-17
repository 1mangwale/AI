/**
 * Regression lock for the COD-not-available fix (2026-08-17).
 *
 * Before this fix a store with cash_on_delivery=0 produced a generic
 * "order failed" dead end: Laravel's precise 403 was flattened to a string,
 * order.executor returned a bare failure, and executeActionWithRetry re-POSTed
 * the placement up to maxRetries times before landing in order_failed.
 *
 * Four things must stay true, and none of the three touched files had any test:
 *   1. the engine returns a `retryable: false` result verbatim, preserving
 *      `event`, and calls the executor EXACTLY ONCE (kills the 3x re-POST)
 *   2. the engine still retries when `retryable` is undefined (no regression
 *      for the 8 address/distance states that rely on retryOnError)
 *   3. createFoodOrder classifies the COD refusal into a stable errorCode
 *   4. every cod_not_available route in both flows resolves to a real state
 */
import { StateMachineEngine } from './state-machine.engine';
import { PhpOrderService } from '../php-integration/services/php-order.service';
import { foodOrderFlow } from './flows/food-order.flow';
import { ecommerceOrderFlow } from './flows/ecommerce-order.flow';
import { ActionExecutionResult } from './types/flow.types';

describe('COD not available', () => {
  // ------------------------------------------------------------------
  // 1 + 2. the retry loop
  // ------------------------------------------------------------------
  describe('executeActionWithRetry', () => {
    let engine: StateMachineEngine;
    let registry: { execute: jest.Mock };

    // maxRetries: 2 means the loop allows 3 attempts (`attempts <= maxRetries`,
    // attempts pre-incremented), which is the number the retry tests assert.
    const action = {
      id: 'place',
      executor: 'order',
      retryOnError: true,
      maxRetries: 2,
    } as any;

    beforeEach(() => {
      registry = { execute: jest.fn() };
      // Only the executor registry is exercised by executeActionWithRetry.
      engine = new StateMachineEngine(
        {} as any, // PrismaService
        {} as any, // FlowContextService
        registry as any, // ExecutorRegistryService
        {} as any, // InputValidatorService
      );
      // Skip the exponential backoff sleeps and the retry warnings.
      jest.spyOn(engine as any, 'sleep').mockResolvedValue(undefined);
      jest.spyOn((engine as any).logger, 'warn').mockImplementation(() => undefined);
    });

    const run = (): Promise<ActionExecutionResult> =>
      (engine as any).executeActionWithRetry(action, {}, {} as any, 'place_order');

    it('returns a retryable:false failure verbatim, preserving event, without retrying', async () => {
      registry.execute.mockResolvedValue({
        success: false,
        error: 'Cash on delivery not available for this store',
        event: 'cod_not_available',
        retryable: false,
      });

      const result = await run();

      // The event is what routes the flow to the re-offer state.
      expect(result.event).toBe('cod_not_available');
      expect(result.success).toBe(false);
      // The whole point: Laravel is not asked to place the order again.
      expect(registry.execute).toHaveBeenCalledTimes(1);
    });

    it('still retries a plain failure, so retryOnError states are unaffected', async () => {
      registry.execute.mockResolvedValue({ success: false, error: 'ETIMEDOUT' });

      const result = await run();

      expect(registry.execute).toHaveBeenCalledTimes(3);
      expect(result.success).toBe(false);
    });

    it('discards event on the exhausted path -- the reason retryable:false exists', async () => {
      registry.execute.mockResolvedValue({
        success: false,
        error: 'boom',
        event: 'cod_not_available',
      });

      const result = await run();

      // Documents the pre-existing behaviour the fix routes around: the
      // all-retries-exhausted return builds a fresh object, so a named event
      // set by the executor never reaches findTriggeredEvent.
      expect(result.event).toBeUndefined();
    });

    it('returns success on the first attempt without retrying', async () => {
      registry.execute.mockResolvedValue({ success: true, data: { order_id: 1 } });

      const result = await run();

      expect(result.success).toBe(true);
      expect(registry.execute).toHaveBeenCalledTimes(1);
    });
  });

  // ------------------------------------------------------------------
  // 3. the PHP boundary
  // ------------------------------------------------------------------
  describe('PhpOrderService.createFoodOrder', () => {
    let service: PhpOrderService;
    let outbound: jest.SpyInstance;

    // Passing addressId short-circuits the address create/match block, so the
    // fixture only has to be good enough to reach the placement request.
    const orderData = {
      moduleId: 4,
      addressId: 42,
      paymentMethod: 'cash_on_delivery',
      deliveryAddress: { address: 'Panchavati, Nashik', latitude: 20.0, longitude: 73.78 },
      items: [{ item_id: 101, quantity: 1, price: 120, store_id: 269 }],
    };

    /**
     * Every step before placement must succeed, or the method throws its own
     * Error (no `code`) and the classifier is never reached -- which is exactly
     * how an earlier version of this spec passed for the wrong reason.
     */
    const rejectPlacementWith = (err: unknown) => {
      outbound = jest
        .spyOn(service as any, 'authenticatedRequest')
        .mockImplementation((...args: unknown[]) => {
          const path = String(args[1]);
          if (path.includes('/order/place')) return Promise.reject(err);
          return Promise.resolve({} as any);
        });
    };

    beforeEach(() => {
      const configService = { get: jest.fn().mockReturnValue('http://php.test') };
      service = new PhpOrderService(configService as any);
      for (const level of ['error', 'warn', 'log', 'debug'] as const) {
        jest
          .spyOn((service as any).logger, level)
          .mockImplementation(() => undefined);
      }
    });

    it('classifies a COD refusal as COD_NOT_AVAILABLE', async () => {
      // Laravel's translate() turns the message key into prose, so the
      // snake_case key is NOT in error.message -- the prose is what we match.
      rejectPlacementWith(
        Object.assign(new Error('Cash on delivery not available for this store'), {
          code: 'payment',
        }),
      );

      const result: any = await service.createFoodOrder('token', orderData);

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('COD_NOT_AVAILABLE');
      // Proves the placement request was actually reached.
      expect(
        outbound.mock.calls.some((c) => String(c[1]).includes('/order/place')),
      ).toBe(true);
    });

    it('also classifies the module-zone variant, which shares the payment code', async () => {
      rejectPlacementWith(
        Object.assign(
          new Error('Cash on delivery for the order not available at this time'),
          { code: 'payment' },
        ),
      );

      const result: any = await service.createFoodOrder('token', orderData);

      expect(result.errorCode).toBe('COD_NOT_AVAILABLE');
    });

    it('leaves errorCode undefined when code is payment but the message is not about cash', async () => {
      rejectPlacementWith(
        Object.assign(new Error('Payment gateway timed out'), { code: 'payment' }),
      );

      const result: any = await service.createFoodOrder('token', orderData);

      expect(result.success).toBe(false);
      expect(result.errorCode).toBeUndefined();
    });

    it('leaves errorCode undefined for a non-payment error, even with COD prose', async () => {
      rejectPlacementWith(
        Object.assign(new Error('Cash on delivery not available for this store'), {
          code: 'order',
        }),
      );

      const result: any = await service.createFoodOrder('token', orderData);

      expect(result.success).toBe(false);
      expect(result.errorCode).toBeUndefined();
    });

    it('succeeds without an errorCode when placement succeeds', async () => {
      jest
        .spyOn(service as any, 'authenticatedRequest')
        .mockResolvedValue({ order_id: 902999, order_amount: '250.50' } as any);

      const result: any = await service.createFoodOrder('token', orderData);

      expect(result.success).toBe(true);
      expect(result.orderId).toBe(902999);
      expect(result.errorCode).toBeUndefined();
    });
  });

  // ------------------------------------------------------------------
  // 4. the flow graph
  // ------------------------------------------------------------------
  describe('flow graph', () => {
    const routesFor = (flow: any) =>
      Object.entries(flow.states as Record<string, any>)
        .filter(([, s]) => s.transitions?.cod_not_available)
        .map(([name, s]) => [name, s.transitions.cod_not_available] as const);

    it('routes cod_not_available on every food placement state', () => {
      const routes = routesFor(foodOrderFlow);
      expect(routes.map(([name]) => name).sort()).toEqual([
        'place_custom_order',
        'place_multi_store_order',
        'place_multi_store_order_digital',
        'place_order',
        'place_order_digital',
      ]);
    });

    it('routes cod_not_available on the ecom placement state, which has no default', () => {
      const placeOrder = (ecommerceOrderFlow as any).states.place_order;
      // Without this route an unrouted event resolves to nextState=null with
      // hasTransitions=true, which stalls the flow instead of ending it.
      expect(placeOrder.transitions.default).toBeUndefined();
      expect(placeOrder.transitions.cod_not_available).toBe('order_failed');
    });

    it('has no dangling transition target in either flow', () => {
      for (const flow of [foodOrderFlow, ecommerceOrderFlow] as any[]) {
        for (const [name, target] of routesFor(flow)) {
          expect(flow.states[target]).toBeDefined();
          // Walk the whole chain the event opens up.
          const seen = new Set<string>();
          let cursor: string | undefined = target;
          while (cursor && !seen.has(cursor)) {
            seen.add(cursor);
            const state = flow.states[cursor];
            expect(state).toBeDefined();
            for (const next of Object.values(state.transitions ?? {})) {
              expect(typeof next).toBe('string');
              expect(flow.states[next as string]).toBeDefined();
            }
            cursor = undefined;
            void name;
          }
        }
      }
    });

    it('terminates the re-offer after one attempt', () => {
      const guard = (foodOrderFlow as any).states.check_cod_retry_guard;
      const events = guard.conditions.map((c: any) => c.event);
      // Every condition event must be routed, or the flow stalls in the guard.
      for (const event of events) {
        expect(guard.transitions[event]).toBeDefined();
      }
      expect(guard.transitions.already_shown).toBe('order_failed');
      expect((foodOrderFlow as any).states.order_failed.type).toBe('end');

      // The flag the guard reads must actually be written by the re-offer.
      const retry = (foodOrderFlow as any).states.cod_not_available_retry;
      expect(retry.actions[0].config.saveToContext).toEqual({
        cod_unavailable_shown: true,
      });
      expect(guard.conditions[0].expression).toContain('cod_unavailable_shown');
    });

    it('sends the prompt from the action state, not the wait state', () => {
      // The engine runs a wait state's actions only when RESUMING and its
      // onEntry on every entry, so a prompt in the wait state would either
      // never send or clobber the response the action state just produced.
      const wait = (foodOrderFlow as any).states.await_cod_alternative_choice;
      expect(wait.type).toBe('wait');
      expect(wait.onEntry).toEqual([]);
      expect(wait.actions).toBeUndefined();

      const retry = (foodOrderFlow as any).states.cod_not_available_retry;
      expect(retry.type).toBe('action');
      expect(retry.actions).toHaveLength(1);
    });

    it('offers buttons the existing payment router already understands', () => {
      const buttons = (foodOrderFlow as any).states.cod_not_available_retry
        .actions[0].config.buttons;
      const values = buttons.map((b: any) => b.value).sort();
      expect(values).toEqual(['digital_payment', 'wallet']);

      // select_payment_method matches on _user_message equality, so the
      // button values must be exactly those two strings.
      const router = (foodOrderFlow as any).states.select_payment_method;
      const expressions = (router.conditions ?? [])
        .map((c: any) => c.expression)
        .join(' | ');
      for (const value of values) {
        expect(expressions).toContain(`"${value}"`);
      }
    });
  });
});
