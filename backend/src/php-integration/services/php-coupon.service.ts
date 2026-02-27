import { Injectable, Logger } from '@nestjs/common';
import { PhpApiService } from './php-api.service';
import { ConfigService } from '@nestjs/config';

/**
 * PHP Coupon Service
 * Maps coupon APIs from PHP backend
 * 
 * API Endpoints:
 * - GET /api/v1/coupon/list (public)
 * - GET /api/v1/coupon/list (authenticated - shows user-specific coupons)
 * - GET /api/v1/coupon/apply
 */

export interface Coupon {
  id: number;
  title: string;
  code: string;
  start_date: string;
  expire_date: string;
  min_purchase: number;
  max_discount: number;
  discount: number;
  discount_type: 'amount' | 'percent';
  coupon_type: 'default' | 'first_order' | 'free_delivery';
  limit: number;
  status: number;
  translations: any[];
}

export interface CouponApplyResult {
  coupon_id: number;
  discount_amount: number;
  discount_type: string;
  code: string;
  is_valid: boolean;
  max_discount?: number;
  min_purchase?: number;
  message?: string;
}

@Injectable()
export class PhpCouponService extends PhpApiService {
  constructor(configService: ConfigService) {
    super(configService);
  }

  /**
   * Get list of available coupons
   * @param token Optional user authentication token (shows user-specific coupons if provided)
   * @returns List of available coupons
   */
  async getCoupons(token?: string, zoneId?: number): Promise<{
    success: boolean;
    coupons?: Coupon[];
    message?: string;
  }> {
    try {
      this.logger.log('Getting available coupons');

      // PHP CouponController requires zoneId header ($request->hasHeader('zoneId'))
      const headers: Record<string, string> = {};
      if (zoneId) {
        headers.zoneId = JSON.stringify([zoneId]);
      }

      let response;
      if (token) {
        // Authenticated request - shows user-specific coupons
        response = await this.authenticatedRequest(
          'get',
          '/api/v1/coupon/list',
          token,
          {},
          headers,
        );
      } else {
        // Public request - shows all active coupons
        response = await this.get('/api/v1/coupon/list/all', {}, headers);
      }

      if (response && Array.isArray(response)) {
        const coupons = response.map((coupon: any) => ({
          id: coupon.id,
          title: coupon.title,
          code: coupon.code,
          start_date: coupon.start_date,
          expire_date: coupon.expire_date,
          min_purchase: parseFloat(coupon.min_purchase || 0),
          max_discount: parseFloat(coupon.max_discount || 0),
          discount: parseFloat(coupon.discount || 0),
          discount_type: coupon.discount_type,
          coupon_type: coupon.coupon_type,
          limit: parseInt(coupon.limit || 0),
          status: coupon.status,
          translations: coupon.translations || [],
        }));

        return {
          success: true,
          coupons,
        };
      }

      return {
        success: false,
        message: 'No coupons available',
      };
    } catch (error) {
      this.logger.error(`Error getting coupons: ${error.message}`);
      return {
        success: false,
        message: error.message || 'Failed to fetch coupons',
      };
    }
  }

  /**
   * Apply coupon code to order
   * @param token User authentication token
   * @param code Coupon code
   * @param orderAmount Order amount to apply coupon
   * @param storeId Store ID (optional for store-specific coupons)
   * @returns Coupon application result
   */
  async applyCoupon(
    token: string,
    code: string,
    orderAmount: number,
    storeId: number,
  ): Promise<{
    success: boolean;
    result?: CouponApplyResult;
    message?: string;
  }> {
    try {
      this.logger.log(`Applying coupon code: ${code}`);

      // PHP validator requires store_id ('store_id' => 'required')
      const params: any = {
        code,
        order_amount: orderAmount,
        store_id: storeId,
      };

      const response = await this.authenticatedRequest(
        'get',
        '/api/v1/coupon/apply',
        token,
        params,
      );

      // PHP CouponController::apply() returns the full Coupon model on success.
      // The coupon ID is in `response.id` (not `response.coupon_id`).
      // Discount fields come from the Coupon model directly.
      if (response && response.id) {
        return {
          success: true,
          result: {
            coupon_id: response.id,
            discount_amount: parseFloat(response.discount || 0),
            discount_type: response.discount_type,
            code: response.code || code,
            is_valid: true,
            max_discount: parseFloat(response.max_discount || 0),
            min_purchase: parseFloat(response.min_purchase || 0),
          },
        };
      }

      return {
        success: false,
        message: response?.message || 'Invalid coupon code',
      };
    } catch (error) {
      this.logger.error(`Error applying coupon: ${error.message}`);
      return {
        success: false,
        message: error.response?.data?.message || error.message || 'Failed to apply coupon',
      };
    }
  }

  /**
   * Get coupon details by code
   * @param code Coupon code
   * @returns Coupon details
   */
  async getCouponByCode(code: string): Promise<{
    success: boolean;
    coupon?: Coupon;
    message?: string;
  }> {
    try {
      this.logger.log(`Getting coupon by code: ${code}`);
      
      const couponsResult = await this.getCoupons();
      
      if (couponsResult.success && couponsResult.coupons) {
        const coupon = couponsResult.coupons.find(
          (c) => c.code.toLowerCase() === code.toLowerCase(),
        );

        if (coupon) {
          return {
            success: true,
            coupon,
          };
        }
      }

      return {
        success: false,
        message: 'Coupon not found',
      };
    } catch (error) {
      this.logger.error(`Error getting coupon by code: ${error.message}`);
      return {
        success: false,
        message: error.message || 'Failed to fetch coupon',
      };
    }
  }

  /**
   * Get coupons by type
   * @param token User authentication token
   * @param type Coupon type ('default' | 'first_order' | 'free_delivery')
   * @returns Filtered coupons
   */
  async getCouponsByType(token: string, type: string): Promise<{
    success: boolean;
    coupons?: Coupon[];
    message?: string;
  }> {
    try {
      this.logger.log(`Getting coupons by type: ${type}`);
      
      const couponsResult = await this.getCoupons(token);
      
      if (couponsResult.success && couponsResult.coupons) {
        const filteredCoupons = couponsResult.coupons.filter(
          (c) => c.coupon_type === type,
        );

        return {
          success: true,
          coupons: filteredCoupons,
        };
      }

      return {
        success: false,
        message: 'No coupons found for this type',
      };
    } catch (error) {
      this.logger.error(`Error getting coupons by type: ${error.message}`);
      return {
        success: false,
        message: error.message || 'Failed to fetch coupons',
      };
    }
  }
}
