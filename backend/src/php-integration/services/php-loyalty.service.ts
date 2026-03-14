import { Injectable, Logger } from '@nestjs/common';
import { PhpApiService } from './php-api.service';
import { ConfigService } from '@nestjs/config';
import { CircuitBreakerService } from '../../common/services/circuit-breaker.service';

/**
 * PHP Loyalty Service
 * Maps loyalty points APIs from PHP backend
 * 
 * API Endpoints:
 * - GET /api/v1/customer/loyalty/points
 * - GET /api/v1/customer/loyalty/transactions
 * - POST /api/v1/customer/loyalty/convert
 */

export interface LoyaltyPoints {
  points: number;
  currency_value: number;
  exchange_rate: number;
  min_points_to_redeem: number;
}

export interface LoyaltyTransaction {
  id: number;
  user_id: number;
  transaction_id: string;
  credit: number;
  debit: number;
  balance: number;
  reference: string;
  transaction_type: 'order_place' | 'loyalty_point' | 'point_to_wallet' | 'referral';
  created_at: string;
}

@Injectable()
export class PhpLoyaltyService extends PhpApiService {
  constructor(configService: ConfigService, circuitBreaker: CircuitBreakerService) {
    super(configService, circuitBreaker);
  }

  /**
   * Get customer loyalty points balance
   * @param token User authentication token
   * @returns Loyalty points information
   */
  async getLoyaltyPoints(token: string): Promise<{
    success: boolean;
    points?: LoyaltyPoints;
    message?: string;
  }> {
    try {
      this.logger.log('Getting loyalty points balance');
      
      const response = await this.authenticatedRequest(
        'get',
        '/api/v1/customer/info',
        token,
      );

      if (response && response.loyalty_point !== undefined) {
        return {
          success: true,
          points: {
            points: parseFloat(response.loyalty_point || 0),
            currency_value: parseFloat(response.loyalty_point || 0) * parseFloat(response.exchange_rate || 0),
            exchange_rate: parseFloat(response.exchange_rate || 1),
            min_points_to_redeem: parseFloat(response.min_point_to_transfer || 0),
          },
        };
      }

      return {
        success: false,
        message: 'Failed to fetch loyalty points',
      };
    } catch (error) {
      this.logger.error(`Error getting loyalty points: ${error.message}`);
      return {
        success: false,
        message: error.message || 'Failed to fetch loyalty points',
      };
    }
  }

  /**
   * Get loyalty points transaction history
   * @param token User authentication token
   * @param limit Number of transactions to fetch
   * @returns List of loyalty transactions
   */
  async getLoyaltyTransactions(token: string, limit: number = 10): Promise<{
    success: boolean;
    transactions?: LoyaltyTransaction[];
    message?: string;
  }> {
    try {
      this.logger.log(`Getting loyalty transactions (limit: ${limit})`);
      
      // PHP route: GET /api/v1/customer/loyalty-point/transactions (separate controller)
      // NOT /api/v1/customer/wallet/transactions (which returns wallet transactions)
      const response = await this.authenticatedRequest(
        'get',
        '/api/v1/customer/loyalty-point/transactions',
        token,
        { limit, offset: 1 },
      );

      if (response && response.data) {
        const transactions = response.data.map((tx: any) => ({
          id: tx.id,
          user_id: tx.user_id,
          transaction_id: tx.transaction_id || `LP${tx.id}`,
          credit: parseFloat(tx.credit || 0),
          debit: parseFloat(tx.debit || 0),
          balance: parseFloat(tx.balance || 0),
          reference: tx.reference || '',
          transaction_type: tx.transaction_type,
          created_at: tx.created_at,
        }));

        return {
          success: true,
          transactions,
        };
      }

      return {
        success: false,
        message: 'No transactions found',
      };
    } catch (error) {
      this.logger.error(`Error getting loyalty transactions: ${error.message}`);
      return {
        success: false,
        message: error.message || 'Failed to fetch loyalty transactions',
      };
    }
  }

  /**
   * Convert loyalty points to wallet balance
   * @param token User authentication token
   * @param points Number of points to convert
   * @returns Conversion result
   */
  async convertPointsToWallet(token: string, points: number): Promise<{
    success: boolean;
    amount_added?: number;
    new_balance?: number;
    message?: string;
  }> {
    try {
      this.logger.log(`Converting ${points} loyalty points to wallet`);
      
      // PHP route: POST /api/v1/customer/loyalty-point/point-transfer
      // PHP param: 'point' (singular), not 'points'
      const response = await this.authenticatedRequest(
        'post',
        '/api/v1/customer/loyalty-point/point-transfer',
        token,
        { point: points },
      );

      if (response && response.message === 'Converted successfully') {
        return {
          success: true,
          amount_added: parseFloat(response.amount || 0),
          new_balance: parseFloat(response.balance || 0),
          message: 'Points converted successfully',
        };
      }

      return {
        success: false,
        message: response?.message || 'Failed to convert points',
      };
    } catch (error) {
      this.logger.error(`Error converting points: ${error.message}`);
      return {
        success: false,
        message: error.message || 'Failed to convert points',
      };
    }
  }
}
