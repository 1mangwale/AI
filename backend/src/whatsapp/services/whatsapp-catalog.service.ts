import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import * as mysql from 'mysql2/promise';
import { WhatsAppCloudService } from './whatsapp-cloud.service';

@Injectable()
export class WhatsAppCatalogService implements OnModuleInit {
  private readonly logger = new Logger(WhatsAppCatalogService.name);
  private pgPool: Pool;
  private mysqlPool: mysql.Pool;

  constructor(
    private readonly config: ConfigService,
    private readonly whatsapp: WhatsAppCloudService,
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
        CREATE TABLE IF NOT EXISTS whatsapp_catalog_items (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          wa_product_id VARCHAR(100),
          name VARCHAR(255) NOT NULL,
          description TEXT,
          price DECIMAL(10,2) NOT NULL,
          currency VARCHAR(3) DEFAULT 'INR',
          image_url TEXT,
          category VARCHAR(100),
          store_id INTEGER,
          availability VARCHAR(20) DEFAULT 'in_stock',
          synced_at TIMESTAMP,
          created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_catalog_store ON whatsapp_catalog_items(store_id);
        CREATE INDEX IF NOT EXISTS idx_catalog_category ON whatsapp_catalog_items(category);
        ALTER TABLE whatsapp_catalog_items ADD COLUMN IF NOT EXISTS product_retailer_id VARCHAR(100);
        CREATE INDEX IF NOT EXISTS idx_catalog_retailer_id ON whatsapp_catalog_items(product_retailer_id);
      `);
      client.release();
      this.logger.log('WhatsAppCatalogService initialized');
    } catch (error: any) {
      this.logger.error(`Failed to initialize: ${error.message}`);
    }
  }

  /**
   * Sync popular products from PHP MySQL into the local PG catalog table.
   */
  async syncCatalog(storeId?: number): Promise<{ synced: number }> {
    const storeFilter = storeId ? 'AND p.store_id = ?' : '';
    const params = storeId ? [storeId] : [];

    const [rows] = await this.mysqlPool.query<mysql.RowDataPacket[]>(
      `
      SELECT
        p.id AS product_id,
        p.name,
        p.description,
        p.price,
        p.image AS image_url,
        c.name AS category,
        p.store_id
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.status = 'active'
        ${storeFilter}
      ORDER BY p.order_count DESC, p.id DESC
      LIMIT 200
      `,
      params,
    );

    let synced = 0;
    const client = await this.pgPool.connect();
    try {
      for (const row of rows) {
        await client.query(
          `
          INSERT INTO whatsapp_catalog_items
            (wa_product_id, name, description, price, image_url, category, store_id, synced_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
          ON CONFLICT (id) DO NOTHING
          `,
          [
            String(row.product_id),
            row.name,
            row.description,
            row.price,
            row.image_url,
            row.category,
            row.store_id,
          ],
        );
        synced++;
      }
    } finally {
      client.release();
    }

    this.logger.log(`Synced ${synced} catalog items${storeId ? ` for store ${storeId}` : ''}`);
    return { synced };
  }

  /**
   * Query products from the local catalog.
   */
  async getProducts(filters?: {
    category?: string;
    storeId?: number;
    limit?: number;
  }): Promise<any[]> {
    const conditions: string[] = [];
    const params: any[] = [];
    let idx = 1;

    if (filters?.category) {
      conditions.push(`category = $${idx++}`);
      params.push(filters.category);
    }
    if (filters?.storeId) {
      conditions.push(`store_id = $${idx++}`);
      params.push(filters.storeId);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filters?.limit || 50;

    const { rows } = await this.pgPool.query(
      `SELECT * FROM whatsapp_catalog_items ${where} ORDER BY synced_at DESC NULLS LAST LIMIT $${idx}`,
      [...params, limit],
    );

    return rows.map(this.mapRow);
  }

  /**
   * Get distinct categories from the catalog.
   */
  async getCategories(): Promise<string[]> {
    const { rows } = await this.pgPool.query(
      `SELECT DISTINCT category FROM whatsapp_catalog_items WHERE category IS NOT NULL ORDER BY category`,
    );
    return rows.map((r) => r.category);
  }

  /**
   * Format products as WhatsApp list message sections.
   */
  buildProductListMessage(products: any[]): {
    body: string;
    buttonText: string;
    sections: Array<{
      title?: string;
      rows: Array<{ id: string; title: string; description?: string }>;
    }>;
  } {
    // Group by category
    const grouped: Record<string, any[]> = {};
    for (const p of products) {
      const cat = p.category || 'Other';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(p);
    }

    const sections = Object.entries(grouped)
      .slice(0, 10)
      .map(([category, items]) => ({
        title: category.substring(0, 24),
        rows: items.slice(0, 10).map((item) => ({
          id: `product_${item.waProductId || item.id}`,
          title: item.name.substring(0, 24),
          description: `Rs ${item.price}${item.description ? ' - ' + item.description.substring(0, 48) : ''}`,
        })),
      }));

    return {
      body: `Browse our menu (${products.length} items)`,
      buttonText: 'View Menu',
      sections,
    };
  }

  /**
   * Send catalog as a WhatsApp list message to a user.
   */
  async sendCatalogMessage(
    phoneNumber: string,
    category?: string,
    storeId?: number,
  ): Promise<void> {
    const products = await this.getProducts({ category, storeId, limit: 30 });

    if (!products.length) {
      await this.whatsapp.sendText(phoneNumber, 'No products available right now. Please check back later.');
      return;
    }

    const listMsg = this.buildProductListMessage(products);
    await this.whatsapp.sendList(phoneNumber, {
      body: listMsg.body,
      buttonText: listMsg.buttonText,
      sections: listMsg.sections,
      header: 'Mangwale Menu',
      footer: 'Tap an item to add to cart',
    });
  }

  /**
   * Send native product message (SPM/MPM) using Meta catalog.
   * Falls back to list message if WHATSAPP_CATALOG_ID is not configured.
   */
  async sendNativeProductMessage(
    phoneNumber: string,
    options?: { storeId?: number; category?: string; limit?: number },
  ): Promise<void> {
    const catalogId = this.config.get<string>('WHATSAPP_CATALOG_ID');

    if (!catalogId) {
      // Fall back to interactive list message
      this.logger.debug('No WHATSAPP_CATALOG_ID — falling back to list message');
      await this.sendCatalogMessage(phoneNumber, options?.category, options?.storeId);
      return;
    }

    const products = await this.getProducts({
      category: options?.category,
      storeId: options?.storeId,
      limit: options?.limit || 30,
    });

    if (!products.length) {
      await this.whatsapp.sendText(phoneNumber, 'No products available right now. Please check back later.');
      return;
    }

    // Filter to products that have a product_retailer_id (synced with Meta catalog)
    const catalogProducts = products.filter(p => p.productRetailerId);

    if (!catalogProducts.length) {
      // No products mapped to Meta catalog yet — fall back to list
      this.logger.debug('No products with product_retailer_id — falling back to list message');
      await this.sendCatalogMessage(phoneNumber, options?.category, options?.storeId);
      return;
    }

    // Single product → SPM, multiple → MPM
    if (catalogProducts.length === 1) {
      await this.whatsapp.sendProduct(phoneNumber, {
        catalogId,
        productRetailerId: catalogProducts[0].productRetailerId,
        body: catalogProducts[0].description || catalogProducts[0].name,
      });
      return;
    }

    // Group by category for MPM sections
    const grouped: Record<string, any[]> = {};
    for (const p of catalogProducts) {
      const cat = p.category || 'Other';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(p);
    }

    const sections = Object.entries(grouped)
      .slice(0, 10)
      .map(([category, items]) => ({
        title: category.substring(0, 24),
        product_items: items.slice(0, 30).map(item => ({
          product_retailer_id: item.productRetailerId,
        })),
      }));

    await this.whatsapp.sendProductList(phoneNumber, {
      catalogId,
      sections,
      header: 'Our Menu',
      body: `Browse ${catalogProducts.length} items`,
      footer: 'Tap to add to cart',
    });
  }

  private mapRow(row: any) {
    return {
      id: row.id,
      waProductId: row.wa_product_id,
      productRetailerId: row.product_retailer_id,
      name: row.name,
      description: row.description,
      price: parseFloat(row.price),
      currency: row.currency,
      imageUrl: row.image_url,
      category: row.category,
      storeId: row.store_id,
      availability: row.availability,
      syncedAt: row.synced_at,
      createdAt: row.created_at,
    };
  }
}
