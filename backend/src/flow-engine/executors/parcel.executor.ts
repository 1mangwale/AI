import { Injectable, Logger } from '@nestjs/common';
import { PhpParcelService } from '../../php-integration/services/parcel.service';
import { ActionExecutor, ActionExecutionResult, FlowContext } from '../types/flow.types';
import { SentimentAnalysisService } from '../../agents/services/sentiment-analysis.service';
import { AdvancedLearningService } from '../../agents/services/advanced-learning.service';

/**
 * Parcel Executor
 * 
 * Handles parcel-specific logic:
 * - Fetching vehicle categories
 * - Calculating shipping charges
 */
@Injectable()
export class ParcelExecutor implements ActionExecutor {
  readonly name = 'parcel';
  private readonly logger = new Logger(ParcelExecutor.name);

  constructor(
    private readonly phpParcelService: PhpParcelService,
    private readonly sentimentAnalysis: SentimentAnalysisService,
    private readonly advancedLearning: AdvancedLearningService,
  ) {}

  async execute(
    config: Record<string, any>,
    context: FlowContext
  ): Promise<ActionExecutionResult> {
    try {
      const action = config.action || 'get_categories';

      if (action === 'get_categories') {
        return this.getVehicleCategories(config, context);
      } else if (action === 'calculate_shipping') {
        return this.calculateShipping(config, context);
      } else {
        return {
          success: false,
          error: `Unknown action: ${action}`,
        };
      }
    } catch (error) {
      this.logger.error(`Parcel executor failed: ${error.message}`, error.stack);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  private async getVehicleCategories(
    config: any,
    context: FlowContext
  ): Promise<ActionExecutionResult> {
    try {
      // 1. Get pickup location to determine zone
      const pickupAddress = this.resolve(context, config.pickupAddressPath, 'sender_address') || config.pickup_address;
      const dropAddress = this.resolve(context, config.dropAddressPath, 'delivery_address') || config.drop_address;
      
      // Support both .latitude/.longitude (PHP API format) and .lat/.lng (legacy)
      const pickupLat = pickupAddress?.latitude ?? pickupAddress?.lat;
      const pickupLng = pickupAddress?.longitude ?? pickupAddress?.lng;
      const dropLat = dropAddress?.latitude ?? dropAddress?.lat;
      const dropLng = dropAddress?.longitude ?? dropAddress?.lng;

      if (!pickupAddress || !pickupLat || !pickupLng) {
        // Fallback to default if no address (should not happen in flow)
        this.logger.warn('No pickup address found, using default zone');
      }

      let zoneId = config.zoneId;
      let moduleId = config.moduleId;

      // If we have coordinates, get the real zone
      if (!zoneId && pickupLat && pickupLng) {
        try {
          const zoneInfo = await this.phpParcelService.getZoneByLocation(
            pickupLat,
            pickupLng
          );
          zoneId = zoneInfo.primaryZoneId;
          moduleId = zoneInfo.primaryModuleId;
          
          // Store zone info in context for later use
          context.data.zone_id = zoneId;
          context.data.module_id = moduleId;
          context.data.zone_ids = zoneInfo.zoneIds;
        } catch (e) {
          this.logger.warn(`Failed to get zone from location: ${e.message}`);
          // Fallback to defaults or error?
          // For now, let's try to proceed if we can, or fail.
        }
      }

      // 2. Fetch categories
      const categories = await this.phpParcelService.getParcelCategories(moduleId, zoneId);
      this.logger.log(`📦 Fetched ${categories.length} categories for module ${moduleId}, zone ${zoneId}`);

      if (categories.length === 0) {
        return {
          success: false,
          error: 'No parcel vehicle categories available for this zone/module',
          event: 'error',
        };
      }

      const zoneIds = Array.isArray(context.data.zone_ids)
        ? context.data.zone_ids
        : (zoneId ? [zoneId] : []);

      const liveQuotes = new Map<string, any>();
      if (pickupLat && pickupLng && dropLat && dropLng) {
        await Promise.all(categories.map(async (cat) => {
          try {
            const quote = await this.phpParcelService.calculateShippingCharge(
              0.5,
              Number(cat.id),
              zoneIds,
              {
                pickup: pickupAddress,
                drop: dropAddress,
                customer: {
                  name: context.data.sender_name || context.data.customer_name || 'Customer',
                  phone: context.data.phone_number || context.data.user_phone || context._system?.phoneNumber,
                },
                paymentMethodHint: 'upi',
              },
            );
            liveQuotes.set(cat.id.toString(), quote);
          } catch (error) {
            this.logger.warn(`Could not quote vehicle category ${cat.id}: ${error.message}`);
          }
        }));
      }

      // 3. Format as ProductCards — pass ALL PHP fields through. Do not show
      // stale parcel_categories per-km rates; live quote is the pricing truth.
      const cards = categories.map(cat => {
        const quote = liveQuotes.get(cat.id.toString());
        return ({
        id: cat.id.toString(),
        name: cat.name,
        description: cat.description || '',
        image: cat.image_full_url || cat.image,
        price: quote ? `₹${quote.delivery_charge}` : 'Live fare',
        cardType: 'vehicle' as const,
        action: {
          label: 'Select',
          value: cat.id.toString(),
        },
        metadata: {
          quoted_delivery_charge: quote?.delivery_charge,
          quoted_total_charge: quote?.total_charge,
          quote_id: quote?.quote_id,
          pricing_source: quote?.pricing_source,
          vehicle_type: quote?.vehicle_type,
          description: cat.description,
          orders_count: cat.orders_count,
          module_id: cat.module_id,
        },
        });
      });

      this.logger.log(`Generated ${cards.length} cards. First card image: ${cards[0]?.image}`);

      return {
        success: true,
        output: cards, // Return the list of cards
        event: 'categories_fetched',
      };
    } catch (error) {
      this.logger.error(`Failed to get vehicle categories: ${error.message}`);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  private async calculateShipping(
    config: any,
    context: FlowContext
  ): Promise<ActionExecutionResult> {
    try {
      const distance = this.resolve(context, config.distancePath, 'distance');
      const categoryId = this.resolve(context, config.categoryPath, 'parcel_category_id');
      const zoneIds = context.data.zone_ids || (context.data.zone_id ? [context.data.zone_id] : []);
      if (zoneIds.length === 0) {
        this.logger.warn(`⚠️ calculateShipping called without zone_id — pricing may be inaccurate`);
      }

      if (distance === null || distance === undefined || !categoryId) {
        this.logger.warn(`Missing data: distance=${distance}, categoryId=${categoryId}`);
        
        // Phase 2: Analyze sentiment for failed calculation (user might be confused)
        const userMessage = context.data._user_message || '';
        if (userMessage) {
          try {
            const sentiment = await this.sentimentAnalysis.analyze(userMessage, {
              conversation_history: context.data._conversation_history || [],
              flow_stage: 'parcel_shipping_calculation_failed',
            });

            await this.advancedLearning.recordTrainingData({
              message: userMessage,
              questionType: 'parcel_shipping_request',
              actualClassification: false,
              predictedClassification: false,
              confidence: 0.2,
              flowContext: 'parcel_booking',
              language: this.detectLanguage(userMessage),
              userId: context._system?.userId || 'unknown',
              sessionId: context._system?.sessionId || 'unknown',
            });

            if (sentiment.frustration_score > 0.7) {
              this.logger.log(`🚨 User frustrated during parcel booking (missing data)`);
            }
          } catch (error) {
            this.logger.warn(`Phase 2 analysis failed: ${error.message}`);
          }
        }
        
        return {
          success: false,
          error: 'Distance and Category ID are required for shipping calculation',
        };
      }

      // Ensure minimum distance for pricing
      const effectiveDistance = Math.max(distance, 0.5); // Minimum 0.5 km for calculation

      const pricing = await this.phpParcelService.calculateShippingCharge(
        effectiveDistance,
        categoryId,
        zoneIds,
        {
          pickup: this.resolve(context, 'pickup_address', 'pickup_address'),
          drop: this.resolve(context, 'delivery_address', 'delivery_address'),
          customer: {
            name: context.data.sender_name || context.data.customer_name || 'Customer',
            phone: context.data.phone_number || context.data.user_phone || context._system?.phoneNumber,
          },
          paymentMethodHint: 'upi',
        }
      );

      // Phase 2: Record successful calculation for learning
      const userMessage = context.data._user_message || '';
      if (userMessage) {
        try {
          const sentiment = await this.sentimentAnalysis.analyze(userMessage, {
            conversation_history: context.data._conversation_history || [],
            flow_stage: 'parcel_shipping_calculated',
          });

          await this.advancedLearning.recordTrainingData({
            message: userMessage,
            questionType: 'parcel_shipping_request',
            actualClassification: true,
            predictedClassification: true,
            confidence: 0.9,
            flowContext: 'parcel_booking',
            language: this.detectLanguage(userMessage),
            userId: context._system?.userId || 'unknown',
            sessionId: context._system?.sessionId || 'unknown',
          });

          // Track if pricing causes frustration (might be too high)
          if (sentiment.frustration_score > 0.6 && pricing.total_charge > 100) {
            this.logger.log(`⚠️ Possible price frustration: ₹${pricing.total_charge}, frustration: ${sentiment.frustration_score.toFixed(2)}`);
          }
        } catch (error) {
          this.logger.warn(`Phase 2 analysis failed: ${error.message}`);
        }
      }

      return {
        success: true,
        output: pricing,
        event: 'shipping_calculated',
      };
    } catch (error) {
      this.logger.error(`Failed to calculate shipping: ${error.message}`);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  private resolve(context: FlowContext, path: string, defaultKey: string): any {
    if (!path) return context.data[defaultKey];
    return path.split('.').reduce((o, i) => o?.[i], context.data);
  }

  /**
   * Phase 2: Detect language of user message for training data
   */
  private detectLanguage(message: string): 'en' | 'hi' | 'hinglish' {
    const hindiPattern = /[\u0900-\u097F]/;
    const hinglishKeywords = /\b(kya|hai|ho|ji|bhai|dost|acha|thik|sahi|nahi|haan|accha|theek|bolo|batao|samjha)\b/i;

    if (hindiPattern.test(message)) {
      return 'hi';
    } else if (hinglishKeywords.test(message)) {
      return 'hinglish';
    }
    return 'en';
  }

  validate(config: Record<string, any>): boolean {
    return !!config.action;
  }
}
