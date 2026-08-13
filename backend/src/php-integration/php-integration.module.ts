import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { PhpHttpClientService } from './services/http-client.service';
import { PhpParcelService } from './services/parcel.service';
import { PhpApiService } from './services/php-api.service';
import { PhpAuthService } from './services/php-auth.service';
import { PhpAddressService } from './services/php-address.service';
import { PhpOrderService } from './services/php-order.service';
import { PhpPaymentService } from './services/php-payment.service';
import { PhpWalletService } from './services/php-wallet.service';
import { PhpLoyaltyService } from './services/php-loyalty.service';
import { PhpCouponService } from './services/php-coupon.service';
import { PhpReviewService } from './services/php-review.service';
import { PhpStoreService } from './services/php-store.service';
import { PhpVendorAuthService } from './services/php-vendor-auth.service';
import { PhpDeliveryAuthService } from './services/php-delivery-auth.service';
import { UserTypeDetectorService } from './services/user-type-detector.service';
import { VendorNotificationService } from './services/vendor-notification.service';
import { PhpWishlistService } from './services/php-wishlist.service';
import { OrderDatabaseService } from './services/order-database.service';
import { RoutingModule } from '../routing/routing.module';
import { WhatsAppCloudService } from '../whatsapp/services/whatsapp-cloud.service';

@Module({
  imports: [
    ConfigModule,
    HttpModule.register({
      timeout: 30000,
      maxRedirects: 5,
    }),
    RoutingModule,
  ],
  providers: [
    PhpHttpClientService,
    PhpParcelService,
    PhpApiService,
    PhpAuthService,
    PhpAddressService,
    PhpOrderService,
    PhpPaymentService,
    PhpWalletService,
    PhpLoyaltyService,
    PhpCouponService,
    PhpReviewService,
    PhpStoreService,
    PhpVendorAuthService,
    PhpDeliveryAuthService,
    UserTypeDetectorService,
    VendorNotificationService,
    PhpWishlistService,
    OrderDatabaseService,
    // Local provider (not an import of WhatsAppModule) — it depends only on
    // ConfigService + HttpService, both already available here. Importing the
    // full WhatsApp module would create a Nest circular dependency.
    WhatsAppCloudService,
  ],
  exports: [
    PhpHttpClientService,
    PhpParcelService,
    PhpApiService,
    PhpAuthService,
    PhpAddressService,
    PhpOrderService,
    PhpPaymentService,
    PhpWalletService,
    PhpLoyaltyService,
    PhpCouponService,
    PhpReviewService,
    PhpStoreService,
    PhpVendorAuthService,
    PhpDeliveryAuthService,
    UserTypeDetectorService,
    VendorNotificationService,
    PhpWishlistService,
    OrderDatabaseService,
  ],
})
export class PhpIntegrationModule {}
