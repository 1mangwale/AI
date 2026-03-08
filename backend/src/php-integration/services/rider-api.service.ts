import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { OrderWebhookPayload } from '../controllers/order-webhook.controller';

/**
 * Rider API Service
 *
 * Bridges NestJS (Jupiter) → Vega Rider API (192.168.0.148:4000)
 *
 * The Rider API handles:
 * - Rider assignment and dispatch
 * - Shipment creation and tracking
 * - Delivery status updates
 *
 * Endpoints used:
 * - POST /api/dispatcher/create-order — Create shipment for rider assignment
 * - POST /api/dispatcher/cancel-order — Cancel a dispatched order
 * - POST /api/dispatcher/track-order — Get delivery tracking info
 * - GET  /api/dispatcher/get-quote   — Get delivery pricing quote
 */
@Injectable()
export class RiderApiService {
  private readonly logger = new Logger(RiderApiService.name);
  private readonly client: AxiosInstance;
  private readonly enabled: boolean;

  constructor(private readonly configService: ConfigService) {
    const baseURL = this.configService.get<string>(
      'RIDER_API_URL',
      'http://192.168.0.148:4000',
    );
    const apiKey = this.configService.get<string>(
      'RIDER_API_KEY',
      '',
    );

    this.enabled = !!apiKey;

    this.client = axios.create({
      baseURL,
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { 'x-api-key': apiKey } : {}),
      },
    });

    if (this.enabled) {
      this.logger.log(`Rider API service initialized → ${baseURL}`);
    } else {
      this.logger.warn('Rider API service disabled — RIDER_API_KEY not configured');
    }
  }

  /**
   * Forward a new order to the Rider API for rider assignment.
   * Called when PHP backend sends an order.created webhook.
   */
  async dispatchOrder(payload: OrderWebhookPayload): Promise<{
    success: boolean;
    shipmentId?: string;
    message?: string;
  }> {
    if (!this.enabled) {
      this.logger.warn('Rider API disabled — skipping order dispatch');
      return { success: false, message: 'Rider API not configured' };
    }

    try {
      const orderData = {
        dispatcher_order_id: String(payload.order.id),
        dispatcher_name: 'mangwale-nestjs',
        customer_name: payload.customer?.name || 'Customer',
        customer_phone: payload.customer?.phone || '',
        customer_address: payload.delivery_address?.address || '',
        customer_latitude: payload.delivery_address?.latitude || 0,
        customer_longitude: payload.delivery_address?.longitude || 0,
        pickup_name: payload.vendor?.store_name || 'Store',
        pickup_phone: payload.vendor?.phone || '',
        pickup_address: payload.vendor?.store_name || '',
        pickup_latitude: 0, // Will be resolved by Rider API from store data
        pickup_longitude: 0,
        instructions: `Order #${payload.order.order_id} - ${payload.items?.map(i => `${i.quantity}x ${i.name}`).join(', ') || 'Order items'}`,
        cod_amount: payload.order.payment_method === 'cod' ? payload.order.total_amount : 0,
        priority: 'medium' as const,
        items: payload.items?.map(i => ({
          name: i.name,
          price: i.price,
          quantity: i.quantity,
        })) || [],
        webhook_url: `${this.configService.get('APP_URL', 'https://api.mangwale.ai')}/api/webhooks/rider-status`,
      };

      this.logger.log(`Dispatching order #${payload.order.id} to Rider API`);
      const response = await this.client.post('/api/dispatcher/create-order', orderData);

      if (response.data?.success) {
        this.logger.log(`Order #${payload.order.id} dispatched → shipment created`);
        return {
          success: true,
          shipmentId: response.data.shipment_id || response.data.external_order_id,
          message: 'Order dispatched to rider',
        };
      }

      this.logger.warn(`Rider API returned failure for order #${payload.order.id}: ${response.data?.error || 'unknown'}`);
      return { success: false, message: response.data?.error || 'Dispatch failed' };
    } catch (error: any) {
      this.logger.error(`Failed to dispatch order #${payload.order.id}: ${error.message}`);
      return { success: false, message: error.message };
    }
  }

  /**
   * Cancel a dispatched order on the Rider API.
   */
  async cancelOrder(orderId: number, reason?: string): Promise<{ success: boolean; message?: string }> {
    if (!this.enabled) return { success: false, message: 'Rider API not configured' };

    try {
      const response = await this.client.post('/api/dispatcher/cancel-order', {
        dispatcher_order_id: String(orderId),
        reason: reason || 'Cancelled by customer',
      });

      return { success: response.data?.success || false, message: response.data?.message };
    } catch (error: any) {
      this.logger.error(`Failed to cancel order #${orderId} on Rider API: ${error.message}`);
      return { success: false, message: error.message };
    }
  }

  /**
   * Get delivery tracking info for an order.
   */
  async trackOrder(orderId: number): Promise<{
    success: boolean;
    status?: string;
    riderName?: string;
    riderPhone?: string;
    location?: { lat: number; lng: number };
    eta?: number;
  }> {
    if (!this.enabled) return { success: false };

    try {
      const response = await this.client.post('/api/dispatcher/track-order', {
        dispatcher_order_id: String(orderId),
      });

      if (response.data?.success) {
        return {
          success: true,
          status: response.data.status,
          riderName: response.data.rider?.name,
          riderPhone: response.data.rider?.phone,
          location: response.data.rider?.location,
          eta: response.data.eta_minutes,
        };
      }

      return { success: false };
    } catch (error: any) {
      this.logger.error(`Failed to track order #${orderId}: ${error.message}`);
      return { success: false };
    }
  }

  /**
   * Get a delivery quote (pricing estimate).
   */
  async getQuote(params: {
    pickupLat: number;
    pickupLng: number;
    dropLat: number;
    dropLng: number;
  }): Promise<{
    success: boolean;
    price?: number;
    distance?: number;
    estimatedTime?: number;
  }> {
    if (!this.enabled) return { success: false };

    try {
      const response = await this.client.get('/api/dispatcher/get-quote', {
        params: {
          pickup_lat: params.pickupLat,
          pickup_lng: params.pickupLng,
          drop_lat: params.dropLat,
          drop_lng: params.dropLng,
        },
      });

      if (response.data?.success) {
        return {
          success: true,
          price: response.data.total_price,
          distance: response.data.distance_km,
          estimatedTime: response.data.estimated_time_minutes,
        };
      }

      return { success: false };
    } catch (error: any) {
      this.logger.error(`Failed to get delivery quote: ${error.message}`);
      return { success: false };
    }
  }
}
