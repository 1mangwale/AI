import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PricingValidatorService } from './pricing.validator';

describe('PricingValidatorService - Security Tests', () => {
  let service: PricingValidatorService;
  let configService: ConfigService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PricingValidatorService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: any) => {
              const config = {
                PARCEL_BASE_CHARGE: 30,
                PARCEL_PER_KM_RATE: 10,
                PARCEL_PLATFORM_FEE_PERCENT: 5,
                PARCEL_MIN_DISTANCE: 1,
                PARCEL_MAX_DISTANCE: 50,
              };
              return config[key] || defaultValue;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<PricingValidatorService>(PricingValidatorService);
    configService = module.get<ConfigService>(ConfigService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('Parcel Order Amount Validation', () => {
    it('should calculate correct parcel order amount', () => {
      // 5km distance: 30 (base) + 50 (5km * 10) = 80
      // Platform fee: 80 * 5% = 4
      // Total: 84
      const pricing = service.calculateParcelOrderAmount(5);

      expect(pricing.distance).toBe(5);
      expect(pricing.baseCharge).toBe(30);
      expect(pricing.distanceCharge).toBe(50);
      expect(pricing.platformFee).toBe(4);
      expect(pricing.totalAmount).toBe(84);
    });

    it('should validate correct parcel order amount within tolerance', () => {
      const validation = service.validateParcelOrderAmount(84, 5);

      expect(validation.valid).toBe(true);
      expect(validation.expected.totalAmount).toBe(84);
      expect(validation.difference).toBe(0);
    });

    it('should reject manipulated parcel order amount', () => {
      // Try to submit ₹1 for a 5km order (expected: ₹84)
      const validation = service.validateParcelOrderAmount(1, 5);

      expect(validation.valid).toBe(false);
      expect(validation.expected.totalAmount).toBe(84);
      expect(validation.difference).toBe(83);
      expect(validation.message).toContain('Order amount mismatch');
    });

    it('should accept amount within 5% tolerance', () => {
      // Expected: ₹84, tolerance: ±5% (±4.2)
      // Valid range: 79.8 - 88.2
      const validation1 = service.validateParcelOrderAmount(80, 5);
      const validation2 = service.validateParcelOrderAmount(88, 5);

      expect(validation1.valid).toBe(true);
      expect(validation2.valid).toBe(true);
    });

    it('should reject amount outside tolerance', () => {
      // Expected: ₹84, tolerance: ±5% (±4.2)
      // Invalid: 200 (way too high)
      const validation = service.validateParcelOrderAmount(200, 5);

      expect(validation.valid).toBe(false);
      expect(validation.message).toContain('Order amount mismatch');
    });

    it('should reject unreasonable distances', () => {
      // Distance > 50km (max)
      expect(() => service.calculateParcelOrderAmount(100)).toThrow(
        'Distance too long',
      );

      // Distance < 1km (min)
      expect(() => service.calculateParcelOrderAmount(0.5)).toThrow(
        'Distance too short',
      );
    });
  });

  describe('Wallet Balance Validation', () => {
    it('should validate sufficient wallet balance', () => {
      const validation = service.validateWalletBalance(
        500, // available balance
        100, // deduction
        200, // order amount
      );

      expect(validation.valid).toBe(true);
    });

    it('should reject insufficient wallet balance', () => {
      const validation = service.validateWalletBalance(
        50, // available balance
        100, // deduction (exceeds balance)
        200, // order amount
      );

      expect(validation.valid).toBe(false);
      expect(validation.message).toContain('Insufficient wallet balance');
    });

    it('should reject wallet deduction exceeding order amount', () => {
      const validation = service.validateWalletBalance(
        500, // available balance
        300, // deduction exceeds order amount
        200, // order amount
      );

      expect(validation.valid).toBe(false);
      expect(validation.message).toContain('exceeds order amount');
    });

    it('should reject negative values', () => {
      const validation1 = service.validateWalletBalance(-100, 50, 200);
      const validation2 = service.validateWalletBalance(500, -50, 200);
      const validation3 = service.validateWalletBalance(500, 50, -200);

      expect(validation1.valid).toBe(false);
      expect(validation2.valid).toBe(false);
      expect(validation3.valid).toBe(false);
      // -100 balance with 50 deduction is caught by "insufficient balance" check first
      expect(validation1.message).toBeDefined();
    });
  });

  describe('Food Order Amount Validation', () => {
    it('should calculate food order amount', () => {
      const items = [
        { price: 100, quantity: 2 },
        { price: 50, quantity: 1 },
      ];

      const pricing = service.calculateFoodOrderAmount(items);

      expect(pricing.itemsTotal).toBe(250); // 200 + 50
      expect(pricing.deliveryCharge).toBe(30);
      expect(pricing.taxes).toBe(13); // 5% of 250 = 12.5, rounded
      expect(pricing.platformFee).toBe(5); // 2% of 250 = 5
      expect(pricing.totalAmount).toBe(298); // 250 + 30 + 13 + 5
    });

    it('should validate food order amount with higher tolerance', () => {
      const items = [{ price: 100, quantity: 2 }];

      // PHP calculates actual amount, this is sanity check with 20% tolerance
      const validation = service.validateFoodOrderAmount(240, items, 20);

      expect(validation.valid).toBe(true);
    });

    it('should reject grossly manipulated food order amount', () => {
      const items = [{ price: 100, quantity: 2 }];

      // Try to submit ₹10 for ₹200 worth of items (way outside 20% tolerance)
      const validation = service.validateFoodOrderAmount(10, items, 20);

      expect(validation.valid).toBe(false);
      expect(validation.message).toContain('mismatch');
    });
  });

  describe('Security Edge Cases', () => {
    it('should handle zero distance gracefully', () => {
      expect(() => service.calculateParcelOrderAmount(0)).toThrow();
    });

    it('should handle zero wallet balance', () => {
      const validation = service.validateWalletBalance(0, 0, 100);
      expect(validation.valid).toBe(true); // Valid: no wallet deduction
    });

    it('should handle large order amounts', () => {
      // 50km (maximum): 30 + 500 = 530 + 5% = 556.5 ≈ 557
      const pricing = service.calculateParcelOrderAmount(50);
      expect(pricing.totalAmount).toBeGreaterThan(500);
      expect(pricing.totalAmount).toBeLessThan(600);
    });

    it('should round amounts correctly', () => {
      const pricing = service.calculateParcelOrderAmount(3.7);
      // Should round properly, no floating point issues
      expect(Number.isInteger(pricing.totalAmount)).toBe(true);
    });
  });
});
