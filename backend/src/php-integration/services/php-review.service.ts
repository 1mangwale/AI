import { Injectable, Logger } from '@nestjs/common';
import { PhpApiService } from './php-api.service';
import { ConfigService } from '@nestjs/config';
import { CircuitBreakerService } from '../../common/services/circuit-breaker.service';

/**
 * PHP Review Service
 * Maps review and rating APIs from PHP backend
 * 
 * API Endpoints:
 * - GET /api/v1/items/reviews/{item_id}
 * - GET /api/v1/items/rating/{item_id}
 * - POST /api/v1/items/reviews/submit
 * - POST /api/v1/delivery-man/reviews/submit
 */

export interface Review {
  id: number;
  item_id?: number;
  delivery_man_id?: number;
  user_id: number;
  customer_name: string;
  rating: number;
  comment: string;
  created_at: string;
  updated_at: string;
}

export interface Rating {
  average: number;
  total_reviews: number;
  rating_breakdown: {
    5: number;
    4: number;
    3: number;
    2: number;
    1: number;
  };
}

@Injectable()
export class PhpReviewService extends PhpApiService {
  constructor(configService: ConfigService, circuitBreaker: CircuitBreakerService) {
    super(configService, circuitBreaker);
  }

  /**
   * Get reviews for an item/product
   * @param itemId Item/Product ID
   * @param limit Number of reviews to fetch
   * @param offset Pagination offset
   * @returns List of reviews
   */
  async getItemReviews(
    itemId: number,
    limit: number = 10,
    offset: number = 1,
  ): Promise<{
    success: boolean;
    reviews?: Review[];
    total?: number;
    message?: string;
  }> {
    try {
      this.logger.log(`Getting reviews for item ${itemId}`);
      
      const response = await this.get(`/api/v1/items/reviews/${itemId}`, {
        limit,
        offset,
      });

      if (response && response.reviews) {
        const reviews = response.reviews.map((review: any) => ({
          id: review.id,
          item_id: review.item_id,
          user_id: review.user_id,
          customer_name: review.customer_name || 'Anonymous',
          rating: parseInt(review.rating || 0),
          comment: review.comment || '',
          created_at: review.created_at,
          updated_at: review.updated_at,
        }));

        return {
          success: true,
          reviews,
          total: response.total || reviews.length,
        };
      }

      return {
        success: false,
        message: 'No reviews found',
      };
    } catch (error) {
      this.logger.error(`Error getting item reviews: ${error.message}`);
      return {
        success: false,
        message: error.message || 'Failed to fetch reviews',
      };
    }
  }

  /**
   * Get rating summary for an item
   * @param itemId Item/Product ID
   * @returns Rating summary
   */
  async getItemRating(itemId: number): Promise<{
    success: boolean;
    rating?: Rating;
    message?: string;
  }> {
    try {
      this.logger.log(`Getting rating for item ${itemId}`);
      
      const response = await this.get(`/api/v1/items/rating/${itemId}`);

      if (response) {
        return {
          success: true,
          rating: {
            average: parseFloat(response.average || 0),
            total_reviews: parseInt(response.total || 0),
            rating_breakdown: {
              5: parseInt(response['5_star'] || 0),
              4: parseInt(response['4_star'] || 0),
              3: parseInt(response['3_star'] || 0),
              2: parseInt(response['2_star'] || 0),
              1: parseInt(response['1_star'] || 0),
            },
          },
        };
      }

      return {
        success: false,
        message: 'No rating data found',
      };
    } catch (error) {
      this.logger.error(`Error getting item rating: ${error.message}`);
      return {
        success: false,
        message: error.message || 'Failed to fetch rating',
      };
    }
  }

  /**
   * Submit review for an item/product
   * @param token User authentication token
   * @param itemId Item/Product ID
   * @param orderId Order ID
   * @param rating Rating (1-5)
   * @param comment Review comment
   * @returns Review submission result
   */
  async submitItemReview(
    token: string,
    itemId: number,
    orderId: number,
    rating: number,
    comment: string,
  ): Promise<{
    success: boolean;
    review_id?: number;
    message?: string;
  }> {
    try {
      this.logger.log(`Submitting review for item ${itemId}`);
      
      const response = await this.authenticatedRequest(
        'post',
        '/api/v1/items/reviews/submit',
        token,
        {
          item_id: itemId,
          order_id: orderId,
          rating,
          comment,
        },
      );

      if (response && response.message === 'Successfully review submitted') {
        return {
          success: true,
          review_id: response.review_id,
          message: 'Review submitted successfully',
        };
      }

      return {
        success: false,
        message: response?.message || 'Failed to submit review',
      };
    } catch (error) {
      this.logger.error(`Error submitting item review: ${error.message}`);
      return {
        success: false,
        message: error.message || 'Failed to submit review',
      };
    }
  }

  /**
   * Get reviews for a delivery man
   * @param deliveryManId Delivery man ID
   * @returns List of reviews
   */
  async getDeliveryManReviews(deliveryManId: number): Promise<{
    success: boolean;
    reviews?: Review[];
    message?: string;
  }> {
    try {
      this.logger.log(`Getting reviews for delivery man ${deliveryManId}`);
      
      const response = await this.get(`/api/v1/delivery-man/reviews/${deliveryManId}`);

      if (response && Array.isArray(response)) {
        const reviews = response.map((review: any) => ({
          id: review.id,
          delivery_man_id: review.delivery_man_id,
          user_id: review.user_id,
          customer_name: review.customer_name || 'Anonymous',
          rating: parseInt(review.rating || 0),
          comment: review.comment || '',
          created_at: review.created_at,
          updated_at: review.updated_at,
        }));

        return {
          success: true,
          reviews,
        };
      }

      return {
        success: false,
        message: 'No reviews found',
      };
    } catch (error) {
      this.logger.error(`Error getting delivery man reviews: ${error.message}`);
      return {
        success: false,
        message: error.message || 'Failed to fetch reviews',
      };
    }
  }

  /**
   * Get rating for a delivery man
   * @param deliveryManId Delivery man ID
   * @returns Rating summary
   */
  async getDeliveryManRating(deliveryManId: number): Promise<{
    success: boolean;
    rating?: Rating;
    message?: string;
  }> {
    try {
      this.logger.log(`Getting rating for delivery man ${deliveryManId}`);
      
      const response = await this.get(`/api/v1/delivery-man/rating/${deliveryManId}`);

      if (response) {
        return {
          success: true,
          rating: {
            average: parseFloat(response.average || 0),
            total_reviews: parseInt(response.total || 0),
            rating_breakdown: {
              5: parseInt(response['5_star'] || 0),
              4: parseInt(response['4_star'] || 0),
              3: parseInt(response['3_star'] || 0),
              2: parseInt(response['2_star'] || 0),
              1: parseInt(response['1_star'] || 0),
            },
          },
        };
      }

      return {
        success: false,
        message: 'No rating data found',
      };
    } catch (error) {
      this.logger.error(`Error getting delivery man rating: ${error.message}`);
      return {
        success: false,
        message: error.message || 'Failed to fetch rating',
      };
    }
  }

  /**
   * Submit review for a delivery man
   * @param token User authentication token
   * @param deliveryManId Delivery man ID
   * @param orderId Order ID
   * @param rating Rating (1-5)
   * @param comment Review comment
   * @returns Review submission result
   */
  async submitDeliveryManReview(
    token: string,
    deliveryManId: number,
    orderId: number,
    rating: number,
    comment: string,
  ): Promise<{
    success: boolean;
    review_id?: number;
    message?: string;
  }> {
    try {
      this.logger.log(`Submitting review for delivery man ${deliveryManId}`);
      
      const response = await this.authenticatedRequest(
        'post',
        '/api/v1/delivery-man/reviews/submit',
        token,
        {
          delivery_man_id: deliveryManId,
          order_id: orderId,
          rating,
          comment,
        },
      );

      if (response && response.message === 'Successfully review submitted') {
        return {
          success: true,
          review_id: response.review_id,
          message: 'Review submitted successfully',
        };
      }

      return {
        success: false,
        message: response?.message || 'Failed to submit review',
      };
    } catch (error) {
      this.logger.error(`Error submitting delivery man review: ${error.message}`);
      return {
        success: false,
        message: error.message || 'Failed to submit review',
      };
    }
  }
}
