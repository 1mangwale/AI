import {
  Controller,
  Get,
  Post,
  Delete,
  Query,
  Param,
  Body,
} from '@nestjs/common';
import { WhatsAppCatalogService } from '../services/whatsapp-catalog.service';
import { WhatsAppOrderFlowService } from '../services/whatsapp-order-flow.service';

@Controller('mos/whatsapp-commerce')
export class WhatsAppCommerceController {
  constructor(
    private readonly catalog: WhatsAppCatalogService,
    private readonly orderFlow: WhatsAppOrderFlowService,
  ) {}

  // ---- Catalog ----

  @Get('catalog')
  getCatalog(
    @Query('category') category?: string,
    @Query('storeId') storeId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.catalog.getProducts({
      category,
      storeId: storeId ? parseInt(storeId) : undefined,
      limit: limit ? parseInt(limit) : undefined,
    });
  }

  @Get('catalog/categories')
  getCategories() {
    return this.catalog.getCategories();
  }

  @Post('catalog/sync')
  syncCatalog(@Query('storeId') storeId?: string) {
    return this.catalog.syncCatalog(storeId ? parseInt(storeId) : undefined);
  }

  @Post('catalog/send')
  sendCatalog(@Body() body: { phoneNumber: string; category?: string; storeId?: number }) {
    return this.catalog.sendCatalogMessage(body.phoneNumber, body.category, body.storeId);
  }

  // ---- Cart ----

  @Post('cart/init')
  initCart(@Body() body: { phoneNumber: string; userId?: number }) {
    return this.orderFlow.initCart(body.phoneNumber, body.userId);
  }

  @Post('cart/:orderId/add')
  addToCart(
    @Param('orderId') orderId: string,
    @Body() body: { product: { productId: string; name: string; price: number }; qty: number },
  ) {
    return this.orderFlow.addToCart(orderId, body.product, body.qty);
  }

  @Delete('cart/:orderId/remove/:productId')
  removeFromCart(
    @Param('orderId') orderId: string,
    @Param('productId') productId: string,
  ) {
    return this.orderFlow.removeFromCart(orderId, productId);
  }

  @Get('cart/:orderId')
  getCart(@Param('orderId') orderId: string) {
    return this.orderFlow.getCart(orderId);
  }

  @Post('cart/:orderId/confirm')
  confirmOrder(
    @Param('orderId') orderId: string,
    @Body() body: { deliveryAddress: any },
  ) {
    return this.orderFlow.confirmOrder(orderId, body.deliveryAddress);
  }

  @Post('cart/:orderId/payment')
  initiatePayment(
    @Param('orderId') orderId: string,
    @Body() body: { method: string },
  ) {
    return this.orderFlow.initiatePayment(orderId, body.method);
  }

  @Post('cart/:orderId/payment/confirm')
  confirmPayment(
    @Param('orderId') orderId: string,
    @Body() body: { paymentRef?: string },
  ) {
    return this.orderFlow.confirmPayment(orderId, body.paymentRef);
  }

  // ---- Orders ----

  @Get('orders')
  getOrders(
    @Query('phone') phone?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    return this.orderFlow.getOrders({
      phone,
      status,
      limit: limit ? parseInt(limit) : undefined,
    });
  }

  @Get('orders/stats')
  getOrderStats() {
    return this.orderFlow.getOrderStats();
  }
}
