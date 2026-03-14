import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import * as mysql from 'mysql2/promise';
import { WhatsAppCloudService } from './whatsapp-cloud.service';
import { PhpPaymentService } from '../../php-integration/services/php-payment.service';

interface CartItem {
  productId: string;
  name: string;
  price: number;
  qty: number;
}

@Injectable()
export class WhatsAppOrderFlowService implements OnModuleInit {
  private readonly logger = new Logger(WhatsAppOrderFlowService.name);
  private pgPool: Pool;
  private mysqlPool: mysql.Pool;

  constructor(
    private readonly config: ConfigService,
    private readonly whatsapp: WhatsAppCloudService,
    @Optional() private readonly phpPayment?: PhpPaymentService,
  ) {}

  async onModuleInit() {
    const databaseUrl =
      this.config.get('DATABASE_URL') ||
      'postgresql://mangwale_config:config_secure_pass_2024@localhost:5432/headless_mangwale?schema=public';
    this.pgPool = new Pool({ connectionString: databaseUrl, max: 5 });

    this.mysqlPool = mysql.createPool({
      host: this.config.get('PHP_DB_HOST') || '103.160.107.208',
      port: parseInt(this.config.get('PHP_DB_PORT') || '3307'),
      user: this.config.get('PHP_DB_USER') || 'readonly_user',
      password: this.config.get('PHP_DB_PASSWORD') || 'readonly_pass_2024',
      database: this.config.get('PHP_DB_NAME') || 'flavours_flavours',
      connectionLimit: 5,
      connectTimeout: 10000,
    });

    try {
      const client = await this.pgPool.connect();
      await client.query(`
        CREATE TABLE IF NOT EXISTS whatsapp_orders (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          phone_number VARCHAR(20) NOT NULL,
          user_id INTEGER,
          items JSONB NOT NULL DEFAULT '[]',
          subtotal DECIMAL(10,2) DEFAULT 0,
          delivery_fee DECIMAL(10,2) DEFAULT 0,
          total DECIMAL(10,2) DEFAULT 0,
          status VARCHAR(20) DEFAULT 'cart',
          payment_method VARCHAR(20),
          payment_ref VARCHAR(100),
          delivery_address JSONB,
          store_id INTEGER,
          php_order_id INTEGER,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_wa_orders_phone ON whatsapp_orders(phone_number);
        CREATE INDEX IF NOT EXISTS idx_wa_orders_status ON whatsapp_orders(status);
      `);
      client.release();
      this.logger.log('WhatsAppOrderFlowService initialized');
    } catch (error: any) {
      this.logger.error(`Failed to initialize: ${error.message}`);
    }
  }

  /**
   * Find an active cart for a phone number, or create a new one.
   */
  async initCart(phoneNumber: string, userId?: number): Promise<any> {
    // Look for an existing active cart
    const { rows } = await this.pgPool.query(
      `SELECT * FROM whatsapp_orders WHERE phone_number = $1 AND status = 'cart' ORDER BY created_at DESC LIMIT 1`,
      [phoneNumber],
    );

    if (rows.length) {
      return this.mapOrder(rows[0]);
    }

    // Create new cart
    const { rows: created } = await this.pgPool.query(
      `INSERT INTO whatsapp_orders (phone_number, user_id) VALUES ($1, $2) RETURNING *`,
      [phoneNumber, userId || null],
    );

    this.logger.log(`Cart created for ${phoneNumber}: ${created[0].id}`);
    return this.mapOrder(created[0]);
  }

  /**
   * Add or update an item in the cart.
   */
  async addToCart(
    orderId: string,
    product: { productId: string; name: string; price: number },
    qty: number,
  ): Promise<any> {
    const order = await this.getRawOrder(orderId);
    if (!order || order.status !== 'cart') {
      throw new Error('Cart not found or already confirmed');
    }

    const items: CartItem[] = order.items || [];
    const existing = items.find((i) => i.productId === product.productId);

    if (existing) {
      existing.qty += qty;
      if (existing.qty <= 0) {
        items.splice(items.indexOf(existing), 1);
      }
    } else if (qty > 0) {
      items.push({
        productId: product.productId,
        name: product.name,
        price: product.price,
        qty,
      });
    }

    const subtotal = items.reduce((sum, i) => sum + i.price * i.qty, 0);
    const deliveryFee = order.delivery_fee ? parseFloat(order.delivery_fee) : 0;
    const total = subtotal + deliveryFee;

    const { rows } = await this.pgPool.query(
      `UPDATE whatsapp_orders
       SET items = $1, subtotal = $2, total = $3, updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [JSON.stringify(items), subtotal, total, orderId],
    );

    return this.mapOrder(rows[0]);
  }

  /**
   * Remove an item from the cart by productId.
   */
  async removeFromCart(orderId: string, productId: string): Promise<any> {
    const order = await this.getRawOrder(orderId);
    if (!order || order.status !== 'cart') {
      throw new Error('Cart not found or already confirmed');
    }

    const items: CartItem[] = (order.items || []).filter(
      (i: CartItem) => i.productId !== productId,
    );

    const subtotal = items.reduce((sum, i) => sum + i.price * i.qty, 0);
    const deliveryFee = order.delivery_fee ? parseFloat(order.delivery_fee) : 0;
    const total = subtotal + deliveryFee;

    const { rows } = await this.pgPool.query(
      `UPDATE whatsapp_orders
       SET items = $1, subtotal = $2, total = $3, updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [JSON.stringify(items), subtotal, total, orderId],
    );

    return this.mapOrder(rows[0]);
  }

  /**
   * Get the cart/order by ID.
   */
  async getCart(orderId: string): Promise<any> {
    const order = await this.getRawOrder(orderId);
    if (!order) throw new Error('Order not found');
    return this.mapOrder(order);
  }

  /**
   * Confirm the order: set delivery address and lock it.
   */
  async confirmOrder(orderId: string, deliveryAddress: any): Promise<any> {
    const { rows } = await this.pgPool.query(
      `UPDATE whatsapp_orders
       SET status = 'confirmed', delivery_address = $1, updated_at = NOW()
       WHERE id = $2 AND status = 'cart'
       RETURNING *`,
      [JSON.stringify(deliveryAddress), orderId],
    );

    if (!rows.length) throw new Error('Cart not found or already confirmed');
    this.logger.log(`Order confirmed: ${orderId}`);
    return this.mapOrder(rows[0]);
  }

  /**
   * Initiate payment for a confirmed order.
   */
  async initiatePayment(
    orderId: string,
    method: string,
  ): Promise<{ order: any; paymentLink?: string }> {
    const order = await this.getRawOrder(orderId);
    if (!order || order.status !== 'confirmed') {
      throw new Error('Order not confirmed');
    }

    await this.pgPool.query(
      `UPDATE whatsapp_orders SET payment_method = $1, status = 'payment_pending', updated_at = NOW() WHERE id = $2`,
      [method, orderId],
    );

    let paymentLink: string | undefined;
    if (method === 'upi' || method === 'digital' || method === 'online') {
      // Use Razorpay payment gateway (user selects UPI/card/netbanking on the Razorpay checkout page)
      try {
        const authToken = await this.resolveAuthToken(order.phone_number);
        if (authToken && this.phpPayment) {
          const result = await this.phpPayment.initializeRazorpay(
            authToken,
            order.php_order_id || parseInt(orderId),
            parseFloat(order.total),
          );
          if (result?.paymentLink) {
            paymentLink = result.paymentLink;
            this.logger.log(`Razorpay payment link generated for order ${orderId}`);
          }
        }
      } catch (err) {
        this.logger.warn(`Razorpay init failed for order ${orderId}: ${err.message} — no payment link sent`);
      }
    }

    const updated = await this.getRawOrder(orderId);
    return { order: this.mapOrder(updated), paymentLink };
  }

  /**
   * Confirm payment received and attempt PHP backend sync.
   */
  async confirmPayment(orderId: string, paymentRef?: string): Promise<any> {
    const { rows } = await this.pgPool.query(
      `UPDATE whatsapp_orders
       SET status = 'paid', payment_ref = $1, updated_at = NOW()
       WHERE id = $2 AND status = 'payment_pending'
       RETURNING *`,
      [paymentRef || null, orderId],
    );

    if (!rows.length) throw new Error('Order not in payment_pending state');

    const order = this.mapOrder(rows[0]);
    this.logger.log(`Payment confirmed for order ${orderId}`);

    // Attempt PHP backend sync (non-fatal)
    await this.attemptPhpSync(order);

    return order;
  }

  /**
   * Attempt to sync a paid WhatsApp order to the PHP Laravel backend.
   * Logs failures as non-fatal for manual reconciliation.
   */
  private async attemptPhpSync(order: any): Promise<void> {
    const phpApiBase = this.config.get('PHP_API_BASE') || 'https://new.mangwale.com/api';

    try {
      const response = await fetch(`${phpApiBase}/whatsapp-orders/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          whatsapp_order_id: order.id,
          phone: order.phoneNumber,
          user_id: order.userId,
          items: order.items,
          subtotal: order.subtotal,
          delivery_fee: order.deliveryFee,
          total: order.total,
          payment_method: order.paymentMethod,
          payment_ref: order.paymentRef,
          delivery_address: order.deliveryAddress,
          store_id: order.storeId,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        const phpOrderId = data?.order_id || data?.id;

        if (phpOrderId) {
          await this.pgPool.query(
            `UPDATE whatsapp_orders SET php_order_id = $1, updated_at = NOW() WHERE id = $2`,
            [phpOrderId, order.id],
          );
          this.logger.log(`Order ${order.id} synced to PHP: php_order_id=${phpOrderId}`);
        }
      } else {
        const errBody = await response.text();
        this.logger.warn(
          `PHP sync failed for order ${order.id} (HTTP ${response.status}): ${errBody.substring(0, 200)}. ` +
          `Flagging for manual reconciliation.`,
        );
        await this.flagForManualSync(order.id, `HTTP ${response.status}: ${errBody.substring(0, 200)}`);
      }
    } catch (err: any) {
      this.logger.warn(
        `PHP sync failed for order ${order.id}: ${err.message}. Flagging for manual reconciliation.`,
      );
      await this.flagForManualSync(order.id, err.message);
    }
  }

  private async flagForManualSync(orderId: string, reason: string): Promise<void> {
    try {
      await this.pgPool.query(
        `CREATE TABLE IF NOT EXISTS whatsapp_order_sync_log (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          order_id UUID NOT NULL,
          sync_status VARCHAR(20) DEFAULT 'pending',
          error_reason TEXT,
          retry_count INTEGER DEFAULT 0,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        )`,
      );
      await this.pgPool.query(
        `INSERT INTO whatsapp_order_sync_log (order_id, sync_status, error_reason)
         VALUES ($1, 'failed', $2)
         ON CONFLICT DO NOTHING`,
        [orderId, reason],
      );
    } catch (logErr: any) {
      this.logger.error(`Failed to log sync failure: ${logErr.message}`);
    }
  }

  /**
   * Send a cart summary with confirm/edit buttons.
   */
  async sendCartSummary(phoneNumber: string, orderId: string): Promise<void> {
    const order = await this.getCart(orderId);
    const items: CartItem[] = order.items || [];

    if (!items.length) {
      await this.whatsapp.sendText(phoneNumber, 'Your cart is empty. Browse the menu to add items.');
      return;
    }

    const lines = items.map(
      (item, i) => `${i + 1}. ${item.name} x${item.qty} - Rs ${(item.price * item.qty).toFixed(2)}`,
    );
    lines.push('');
    lines.push(`Subtotal: Rs ${order.subtotal.toFixed(2)}`);
    if (order.deliveryFee > 0) {
      lines.push(`Delivery: Rs ${order.deliveryFee.toFixed(2)}`);
    }
    lines.push(`*Total: Rs ${order.total.toFixed(2)}*`);

    await this.whatsapp.sendButtons(phoneNumber, {
      body: lines.join('\n'),
      header: 'Your Cart',
      footer: `${items.length} item${items.length > 1 ? 's' : ''}`,
      buttons: [
        { id: `confirm_order_${orderId}`, title: 'Confirm Order' },
        { id: `edit_cart_${orderId}`, title: 'Edit Cart' },
        { id: `clear_cart_${orderId}`, title: 'Clear Cart' },
      ],
    });
  }

  /**
   * Send order confirmation message.
   */
  async sendOrderConfirmation(phoneNumber: string, orderId: string): Promise<void> {
    const order = await this.getCart(orderId);
    const items: CartItem[] = order.items || [];

    const lines = [
      `Order #${orderId.substring(0, 8).toUpperCase()}`,
      '',
      ...items.map((item) => `${item.name} x${item.qty} - Rs ${(item.price * item.qty).toFixed(2)}`),
      '',
      `Total: Rs ${order.total.toFixed(2)}`,
      `Payment: ${order.paymentMethod || 'Pending'}`,
      `Status: ${order.status}`,
    ];

    if (order.deliveryAddress) {
      lines.push('');
      lines.push(`Delivery to: ${order.deliveryAddress.address || JSON.stringify(order.deliveryAddress)}`);
    }

    await this.whatsapp.sendText(phoneNumber, lines.join('\n'));
  }

  /**
   * List orders with optional filters.
   */
  async getOrders(filters?: {
    phone?: string;
    status?: string;
    limit?: number;
  }): Promise<any[]> {
    const conditions: string[] = [];
    const params: any[] = [];
    let idx = 1;

    if (filters?.phone) {
      conditions.push(`phone_number = $${idx++}`);
      params.push(filters.phone);
    }
    if (filters?.status) {
      conditions.push(`status = $${idx++}`);
      params.push(filters.status);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filters?.limit || 50;

    const { rows } = await this.pgPool.query(
      `SELECT * FROM whatsapp_orders ${where} ORDER BY created_at DESC LIMIT $${idx}`,
      [...params, limit],
    );

    return rows.map(this.mapOrder);
  }

  /**
   * Aggregate order stats.
   */
  async getOrderStats(): Promise<any> {
    const { rows } = await this.pgPool.query(`
      SELECT
        status,
        COUNT(*)::int AS count,
        COALESCE(SUM(total), 0) AS revenue
      FROM whatsapp_orders
      GROUP BY status
      ORDER BY count DESC
    `);

    const totals = rows.reduce(
      (acc, r) => ({
        totalOrders: acc.totalOrders + r.count,
        totalRevenue: acc.totalRevenue + parseFloat(r.revenue),
      }),
      { totalOrders: 0, totalRevenue: 0 },
    );

    return { byStatus: rows, ...totals };
  }

  /**
   * Look up the PHP auth token for a phone number from the sessions table.
   * Returns null if no authenticated session exists.
   */
  private async resolveAuthToken(phoneNumber: string): Promise<string | null> {
    try {
      const { rows } = await this.pgPool.query(
        `SELECT data FROM sessions WHERE phone_number = $1 AND data->>'auth_token' IS NOT NULL ORDER BY updated_at DESC LIMIT 1`,
        [phoneNumber],
      );
      return rows[0]?.data?.auth_token || null;
    } catch (err) {
      this.logger.warn(`Failed to resolve auth token for ${phoneNumber}: ${err.message}`);
      return null;
    }
  }

  // ------- helpers -------

  private async getRawOrder(orderId: string): Promise<any> {
    const { rows } = await this.pgPool.query(
      `SELECT * FROM whatsapp_orders WHERE id = $1`,
      [orderId],
    );
    return rows[0] || null;
  }

  private mapOrder(row: any) {
    return {
      id: row.id,
      phoneNumber: row.phone_number,
      userId: row.user_id,
      items: row.items || [],
      subtotal: parseFloat(row.subtotal),
      deliveryFee: parseFloat(row.delivery_fee),
      total: parseFloat(row.total),
      status: row.status,
      paymentMethod: row.payment_method,
      paymentRef: row.payment_ref,
      deliveryAddress: row.delivery_address,
      storeId: row.store_id,
      phpOrderId: row.php_order_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
