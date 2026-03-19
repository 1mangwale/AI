import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PhpAddressService } from '../../php-integration/services/php-address.service';
import { AddressExtractionService } from '../../agents/services/address-extraction.service';
import { SessionService } from '../../session/session.service';
import { QuestionClassifierService } from '../../agents/services/question-classifier.service';
import { IntelligentResponseGenerator } from '../../agents/services/intelligent-response.service';
import { ConversationDeduplicationService } from '../../agents/services/conversation-memory.service';
import { SentimentAnalysisService } from '../../agents/services/sentiment-analysis.service';
import { AdvancedLearningService } from '../../agents/services/advanced-learning.service';
import { LlmService } from '../../llm/services/llm.service';
import { ActionExecutor, ActionExecutionResult, FlowContext } from '../types/flow.types';

/**
 * Address Executor
 * 
 * Collects and validates addresses (with saved address support)
 */
@Injectable()
export class AddressExecutor implements ActionExecutor {
  readonly name = 'address';
  private readonly logger = new Logger(AddressExecutor.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly phpAddressService: PhpAddressService,
    private readonly addressExtraction: AddressExtractionService,
    private readonly sessionService: SessionService,
    private readonly questionClassifier: QuestionClassifierService,
    private readonly intelligentResponse: IntelligentResponseGenerator,
    private readonly conversationMemory: ConversationDeduplicationService,
    private readonly sentimentAnalysis: SentimentAnalysisService,
    private readonly advancedLearning: AdvancedLearningService,
    private readonly llmService: LlmService,
  ) {}

  /**
   * ✅ UPGRADED: Now using ML-based QuestionClassifierService + IntelligentResponseGenerator
   * Old approach: Regex patterns + hardcoded templates
   * New approach: Pattern + LLM hybrid for question detection, LLM-generated responses
   */

  async execute(
    config: Record<string, any>,
    context: FlowContext
  ): Promise<ActionExecutionResult> {
    try {
      const field = config.field as string; // e.g., 'delivery_address'
      const allowSaved = config.allow_saved !== false;
      const requireCoordinates = config.require_coordinates !== false;

      // Check if address already collected
      if (context.data[field]) {
        return {
          success: true,
          output: context.data[field],
          event: 'address_valid',
        };
      }

      // Use config.userMessage if provided (for extracted values), otherwise fall back to _user_message
      const userMessage = (config.userMessage as string) || (context.data._user_message as string) || '';
      this.logger.debug(`🔍 Address executor: field=${field}, userMessage="${userMessage}"`);
      
      // 🔧 FIX: If no user message and no existing address, show prompt (first entry)
      // This prevents crashes from null/undefined userMessage in extraction methods
      if (!userMessage && !context.data[field]) {
        this.logger.debug(`🔍 No user message and no existing address — will show prompt`);
      }
      const session = await this.sessionService.getSession(context._system.sessionId);
      const userId = session?.data?.user_id;
      const authToken = session?.data?.auth_token;
      
      // 🔧 FIX: Detect Google OAuth users who have email + user_name but no PHP userId yet
      const isGoogleOAuthUser = session?.data?.email && session?.data?.user_name && session?.data?.authenticated;
      const isAuthenticated = !!(userId && authToken) || isGoogleOAuthUser;
      
      if (isGoogleOAuthUser && !userId) {
        this.logger.log(`🔐 Google OAuth user detected (${session?.data?.email}) - authenticated but no PHP userId yet`);
      }

      // =====================================================
      // 🛡️ FLOW TRIGGER MESSAGE DETECTION
      // Skip auto-extraction if this is the initial trigger message (not a direct address)
      // e.g., "need to pickup a parcel from my friends house" should NOT auto-extract
      // =====================================================
      // =====================================================
      // 🧠 SMART ADDRESS PRE-MATCHING
      // If user confirms a suggested address, use it directly
      // =====================================================
      if (context.data._suggested_pickup_address && field === 'pickup_address') {
        const confirmMsg = (userMessage || '').toLowerCase().trim();
        const isConfirm = /^(confirm_suggested_pickup|yes|haan|ha|ji|ok|sure|confirm|theek|ठीक|हां|हाँ)$/i.test(confirmMsg)
          || confirmMsg === '✅ yes, pick up here';
        const isShowAll = /^(show_all_addresses|show all|sab dikhao|all|other|nahi|no|change)$/i.test(confirmMsg)
          || confirmMsg === '📋 show all addresses';

        if (isConfirm) {
          const suggested = context.data._suggested_pickup_address as any;
          const addressData = {
            address: suggested.address,
            latitude: parseFloat(suggested.latitude),
            longitude: parseFloat(suggested.longitude),
            contact_person_name: suggested.contactPersonName,
            contact_person_number: suggested.contactPersonNumber,
            address_id: suggested.id,
            source: 'saved_address',
            raw_input: userMessage,
          };
          context.data[field] = addressData;
          delete context.data._suggested_pickup_address;
          delete context.data[`${field}_options`];
          delete context.data[`${field}_offered`];

          const emoji = this.phpAddressService.getAddressTypeEmoji(suggested.addressType);
          context.data._last_response = `✅ Pickup set to your **${suggested.addressType || 'saved'}** address:\n${emoji} ${suggested.address}`;

          this.logger.log(`🧠 Smart match confirmed! Using ${suggested.addressType} address for pickup`);
          return { success: true, output: addressData, event: 'address_valid' };
        }

        if (isShowAll) {
          this.logger.log(`🔄 User wants to see all addresses instead of suggestion`);
          delete context.data._suggested_pickup_address;
          // Fall through to show all saved addresses below
        }
      }

      // =====================================================
      // 🧠 SMART DELIVERY ADDRESS PRE-MATCHING
      // If user confirms a suggested delivery address, use it directly
      // =====================================================
      if (context.data._suggested_delivery_address && field === 'delivery_address') {
        const confirmMsg = (userMessage || '').toLowerCase().trim();
        const isConfirm = /^(confirm_suggested_delivery|yes|haan|ha|ji|ok|sure|confirm|theek|ठीक|हां|हाँ)$/i.test(confirmMsg)
          || confirmMsg === '✅ yes, deliver here';
        const isShowAll = /^(show_all_addresses|show all|sab dikhao|all|other|nahi|no|change)$/i.test(confirmMsg)
          || confirmMsg === '📋 show all addresses';

        if (isConfirm) {
          const suggested = context.data._suggested_delivery_address as any;
          const addressData = {
            address: suggested.address,
            latitude: parseFloat(suggested.latitude),
            longitude: parseFloat(suggested.longitude),
            contact_person_name: suggested.contactPersonName,
            contact_person_number: suggested.contactPersonNumber,
            address_id: suggested.id,
            source: 'saved_address',
            raw_input: userMessage,
          };
          context.data[field] = addressData;
          delete context.data._suggested_delivery_address;
          delete context.data._delivery_address_hint;
          delete context.data[`${field}_options`];
          delete context.data[`${field}_offered`];

          const emoji = this.phpAddressService.getAddressTypeEmoji(suggested.addressType);
          context.data._last_response = `✅ Delivery set to your **${suggested.addressType || 'saved'}** address:\n${emoji} ${suggested.address}`;

          this.logger.log(`🧠 Smart match confirmed! Using ${suggested.addressType} address for delivery`);
          return { success: true, output: addressData, event: 'address_valid' };
        }

        if (isShowAll) {
          this.logger.log(`🔄 User wants to see all addresses instead of delivery suggestion`);
          delete context.data._suggested_delivery_address;
          // Fall through to show all saved addresses below
        }
      }

      const isFlowTriggerMessage = this.isParcelBookingTriggerMessage(userMessage);
      if (isFlowTriggerMessage && field === 'pickup_address' && !context.data._pickup_prompt_shown) {
        this.logger.log(`🚫 Detected flow trigger message - showing pickup prompt instead of auto-extracting: "${userMessage}"`);
        context.data._pickup_prompt_shown = true;
        
        // Show proper pickup prompt with saved addresses if authenticated
        if (userId && authToken) {
          const savedAddresses = await this.phpAddressService.getAddresses(authToken);
          if (savedAddresses && savedAddresses.length > 0) {
            context.data[`${field}_offered`] = true;
            context.data[`${field}_options`] = savedAddresses;

            // =====================================================
            // 🧠 SMART ADDRESS HINT DETECTION
            // Extract "home"/"office"/etc. from trigger, match saved addresses
            // =====================================================
            // Also extract delivery hint for later use when collecting delivery address
            const deliveryHint = this.extractDeliveryHintFromTrigger(userMessage);
            if (deliveryHint) {
              context.data._delivery_address_hint = deliveryHint;
              this.logger.log(`🧠 Delivery hint saved from trigger: "${deliveryHint}"`);
            }

            const addressHint = this.extractAddressHintFromTrigger(userMessage);
            if (addressHint) {
              const matched = this.matchSavedAddressByHint(savedAddresses, addressHint);
              if (matched) {
                context.data._suggested_pickup_address = matched;
                const emoji = this.phpAddressService.getAddressTypeEmoji(matched.addressType);
                const shortAddr = matched.address?.length > 60
                  ? matched.address.substring(0, 60) + '...'
                  : matched.address;

                this.logger.log(`🧠 Smart match! "${addressHint}" → ${matched.addressType}: ${shortAddr}`);

                context.data._last_response = `📦 **Parcel Pickup**\n\n${emoji} I found your saved **${matched.addressType}** address:\n📍 ${shortAddr}\n\nShould I pick up from here?\n\n[BTN|✅ Yes, pick up here|confirm_suggested_pickup]\n[BTN|📋 Show all addresses|show_all_addresses]\n[BTN|📍 Share New Location|__LOCATION__]\n[BTN|❌ Cancel|cancel]`;

                return {
                  success: true,
                  output: null,
                  event: 'waiting_for_input',
                };
              }
            }
            
            const addressButtons = savedAddresses.map((addr, idx) => {
              const emoji = this.phpAddressService.getAddressTypeEmoji(addr.addressType);
              const shortAddr = addr.address?.length > 28 ? addr.address.substring(0, 28) + '...' : addr.address;
              return `[BTN|${emoji} ${addr.addressType || 'Saved'} - ${shortAddr}|${idx + 1}]`;
            }).join('\n');
            
            context.data._last_response = `📦 **Parcel Pickup**\n\n📍 **Question 1/5:** Where should we **pick up** the parcel?\n\nSelect a saved address:\n${addressButtons}\n\n[BTN|📍 Share New Location|__LOCATION__]\n[BTN|❌ Cancel|cancel]`;
          } else {
            context.data._last_response = `📦 **Parcel Pickup**\n\n📍 **Question 1/5:** Where should we **pick up** the parcel?\n\n• Share your live location 📍\n• Type an address\n\n[BTN|📍 Share Location|__LOCATION__]\n[BTN|❌ Cancel|cancel]`;
          }
        } else {
          context.data._last_response = `📦 **Parcel Pickup**\n\n📍 **Question 1/5:** Where should we **pick up** the parcel?\n\n• Share your live location 📍\n• Type an address\n\n[BTN|📍 Share Location|__LOCATION__]\n[BTN|❌ Cancel|cancel]`;
        }
        
        return {
          success: true,
          output: null,
          event: 'waiting_for_input',
        };
      }

      // =====================================================
      // 🚀 COMBINED PICKUP+DROP DETECTION
      // If user provides both pickup AND drop in one message, extract both
      // e.g., "pickup loction 19.959, 73.768 drop location https://maps.app.goo.gl/abc"
      // =====================================================
      if (field === 'pickup_address' && this.addressExtraction.isCombinedPickupDropMessage(userMessage)) {
        this.logger.log(`🎯 Detected combined pickup+drop message: "${userMessage}"`);
        
        const combined = await this.addressExtraction.extractCombinedPickupDrop(userMessage);
        
        if (combined.hasPickup && combined.pickup) {
          const pickupData = {
            address: combined.pickup.address,
            latitude: combined.pickup.latitude,
            longitude: combined.pickup.longitude,
            source: combined.pickup.source,
            raw_input: userMessage,
            ...combined.pickup.metadata,
          };
          context.data.pickup_address = pickupData;
          this.logger.log(`✅ Pickup address extracted from combined: ${pickupData.address}`);
          
          // If we also have drop location, save it for the next step
          if (combined.hasDrop && combined.drop) {
            const dropData = {
              address: combined.drop.address,
              latitude: combined.drop.latitude,
              longitude: combined.drop.longitude,
              source: combined.drop.source,
              raw_input: userMessage,
              ...combined.drop.metadata,
            };
            context.data._pending_delivery_address = dropData;
            this.logger.log(`📦 Drop address saved for next step: ${dropData.address}`);
            
            context.data._last_response = `✅ Got both locations!\n\n📦 **Pickup:** ${pickupData.address}\n📍 **Drop:** ${dropData.address}`;
          } else {
            context.data._last_response = `✅ Pickup confirmed: ${pickupData.address}`;
          }
          
          return {
            success: true,
            output: pickupData,
            event: 'address_valid',
          };
        }
      }
      
      // =====================================================
      // 🧠 DELIVERY ADDRESS HINT AUTO-SUGGESTION
      // If a delivery hint was extracted from the trigger, auto-suggest matching address
      // =====================================================
      if (field === 'delivery_address' && context.data._delivery_address_hint && !context.data._delivery_hint_used) {
        context.data._delivery_hint_used = true; // Prevent re-triggering
        const hint = context.data._delivery_address_hint as string;

        if (userId && authToken) {
          const savedAddresses = await this.phpAddressService.getAddresses(authToken);
          if (savedAddresses && savedAddresses.length > 0) {
            const matched = this.matchSavedAddressByHint(savedAddresses, hint);
            if (matched) {
              context.data._suggested_delivery_address = matched;
              context.data[`${field}_options`] = savedAddresses;
              context.data[`${field}_offered`] = true;

              const emoji = this.phpAddressService.getAddressTypeEmoji(matched.addressType);
              const shortAddr = matched.address?.length > 60
                ? matched.address.substring(0, 60) + '...'
                : matched.address;

              this.logger.log(`🧠 Smart delivery match! "${hint}" → ${matched.addressType}: ${shortAddr}`);

              context.data._last_response = `📍 **Parcel Delivery**\n\n${emoji} I found your saved **${matched.addressType}** address:\n📍 ${shortAddr}\n\nShould I deliver here?\n\n[BTN|✅ Yes, deliver here|confirm_suggested_delivery]\n[BTN|📋 Show all addresses|show_all_addresses]\n[BTN|📍 Share New Location|__LOCATION__]\n[BTN|❌ Cancel|cancel]`;

              return {
                success: true,
                output: null,
                event: 'waiting_for_input',
              };
            }
          }
        }
        // If no match found, fall through to normal delivery collection
        delete context.data._delivery_address_hint;
      }

      // Check if we have a pending delivery address from combined extraction
      if (field === 'delivery_address' && context.data._pending_delivery_address) {
        const pendingDrop = context.data._pending_delivery_address;
        context.data.delivery_address = pendingDrop;
        delete context.data._pending_delivery_address;
        
        this.logger.log(`📍 Using pending delivery address from combined extraction: ${pendingDrop.address}`);
        context.data._last_response = `✅ Delivery address confirmed: ${pendingDrop.address}`;
        
        return {
          success: true,
          output: pendingDrop,
          event: 'address_valid',
        };
      }

      // =====================================================
      // SMART INTENT DETECTION: Understand what user wants
      // =====================================================
      const messageLower = (userMessage || '').toLowerCase().trim();
      
      // Detect if user is asking for saved addresses (various ways people say it)
      const savedAddressIntentPatterns = [
        // Direct mentions
        /my\s*(saved\s*)?(address|location|place)/i,
        /check\s*(from\s*)?(my\s*)?(address|saved|location)/i,
        /use\s*(my\s*)?(saved\s*)?(address|home|office)/i,
        /from\s*my\s*(address|saved|home|office|place)/i,
        /mere?\s*(address|ghar|office|saved)/i,
        /apna\s*(address|ghar|office)/i,
        /(show|dekho|dikhao|batao)\s*(my\s*)?(saved\s*)?(address|location)/i,
        /saved\s*(address|location|place)/i,
        // Home/Office requests
        /^(home|ghar|office|work|daftar)$/i,
        /(my|mera|mere|apna)\s*(home|ghar|office|work|daftar)/i,
      ];
      
      const wantsSavedAddresses = savedAddressIntentPatterns.some(pattern => pattern.test(messageLower));
      
      if (wantsSavedAddresses) {
        this.logger.log(`🧠 Detected saved address intent: "${userMessage}"`);
        
        // If user has PHP auth, fetch and show saved addresses
        if (userId && authToken) {
          const savedAddresses = await this.phpAddressService.getAddresses(authToken);
          
          if (savedAddresses && savedAddresses.length > 0) {
            context.data[`${field}_offered`] = true;
            context.data[`${field}_options`] = savedAddresses;

            const locationLabel = field.includes('pickup') || field.includes('sender') ? 'pickup' : 'delivery';
            const locationEmoji = locationLabel === 'pickup' ? '📦' : '📍';
            
            const addressButtons = savedAddresses.map((addr, idx) => {
              const emoji = this.phpAddressService.getAddressTypeEmoji(addr.addressType);
              const shortAddr = addr.address?.length > 28 ? addr.address.substring(0, 28) + '...' : addr.address;
              return `[BTN|${emoji} ${addr.addressType || 'Saved'} - ${shortAddr}|${idx + 1}]`;
            }).join('\n');

            context.data._last_response = `${locationEmoji} Here are your saved addresses:\n\n${addressButtons}\n\n[BTN|📍 Share New Location|__LOCATION__]\n[BTN|❌ Cancel|cancel]`;

            return {
              success: true,
              output: null,
              event: 'waiting_for_input',
            };
          } else {
            // No saved addresses
            context.data._last_response = `📍 You don't have any saved addresses yet.\n\nPlease share your location or type an address:\n[BTN|📍 Share Location|__LOCATION__]`;
            return {
              success: true,
              output: null,
              event: 'waiting_for_input',
            };
          }
        } else if (isAuthenticated) {
          // 🔧 FIX: Google OAuth user - authenticated but no PHP saved addresses yet
          // Don't ask to login again, just ask for location
          this.logger.log(`🔐 Google OAuth user asking for saved addresses - none available yet`);
          context.data._last_response = `📍 You're logged in but don't have saved addresses in our system yet.\n\nPlease share your location or type an address:\n[BTN|📍 Share Location|__LOCATION__]`;
          return {
            success: true,
            output: null,
            event: 'waiting_for_input',
          };
        } else {
          // Not authenticated at all
          context.data._last_response = `🔐 To use your saved addresses, please login first:\n\n[BTN|🔑 Login to Continue|trigger_auth_flow]\n\nOr share a new location:\n[BTN|📍 Share Location|__LOCATION__]`;
          return {
            success: true,
            output: null,
            event: 'waiting_for_input',
          };
        }
      }

      // EARLY CHECK: If we've already offered addresses and the user's message is generic,
      // just re-show the saved addresses instead of trying to extract (which will fail)
      const savedOptions = context.data[`${field}_options`] as any[];
      if (savedOptions && savedOptions.length > 0) {
        // Check if message is too generic (not an address)
        // Generic messages: short messages, greetings, single words, etc.
        const genericKeywords = ['parcel', 'yes', 'ok', 'no', 'haan', 'ji', 'nahi', 'book', 'send', 'delivery', 'pickup', 'bhej', 'bhejo', 'uthao', 'le lo', 'hello', 'hi', 'hey', 'chotu', 'kya', 'what', 'huh', 'please', 'plz'];
        const greetingPatterns = /^(hello|hi|hey|namaste|namaskar)\b/i;
        const isShortMessage = !userMessage || userMessage.length < 15;
        const containsGenericKeyword = genericKeywords.some(kw => userMessage.toLowerCase().includes(kw));
        const isGreeting = greetingPatterns.test(userMessage);
        const hasNoAddressIndicators = !/\d{2,}|road|street|nagar|colony|chowk|near|opposite|behind|maps\.app|google\.com|goo\.gl|,/i.test(userMessage);
        
        const isGenericMessage = (isShortMessage || containsGenericKeyword || isGreeting) && hasNoAddressIndicators;
        
        // Also check for numeric or address type selections which should be processed normally
        const isSelection = /^[1-9]\d?$/.test(userMessage) || /^(home|office|ghar|work|other)/i.test(userMessage);
        
        // Check for cancel request
        const isCancelRequest = /^(cancel|nahi|no|stop|exit|quit|back|wapas|ruk|rukho)$/i.test(userMessage?.trim());
        if (isCancelRequest) {
          this.logger.log('🚫 User requested cancel during address collection');
          return {
            success: false,
            output: null,
            event: 'user_cancelled',
            error: 'User cancelled',
          };
        }
        
        if (isGenericMessage && !isSelection) {
          this.logger.log(`🔄 Re-offering saved addresses (early check) - message too generic: "${userMessage}"`);
          
          const locationLabel = field.includes('pickup') || field.includes('sender') ? 'PICKUP' : 'DELIVERY';
          const locationEmoji = locationLabel === 'PICKUP' ? '📦' : '📍';
          
          const addressButtons = savedOptions.map((addr, idx) => {
            const emoji = this.phpAddressService.getAddressTypeEmoji(addr.addressType);
            const shortAddr = addr.address?.length > 28 ? addr.address.substring(0, 28) + '...' : addr.address;
            return `[BTN|${emoji} ${addr.addressType || 'Saved'} - ${shortAddr}|${idx + 1}]`;
          }).join('\n');

          context.data._last_response = `${locationEmoji} **Select ${locationLabel} Location**\n\nPlease choose an address or share location:\n${addressButtons}\n\n[BTN|📍 Share New Location|__LOCATION__]\n[BTN|❌ Cancel|cancel]`;

          return {
            success: true,
            output: null,
            event: 'waiting_for_input',
          };
        }
      }

      // Prevent reusing the same message for delivery that was used for pickup
      if (field === 'delivery_address' && context.data.pickup_address) {
        const pickup = context.data.pickup_address;
        const pickupInput = pickup.raw_input || pickup.metadata?.raw_input || pickup.source_message;
        
        this.logger.debug(`📍 Delivery check: pickupInput="${pickupInput}", userMessage="${userMessage}"`);
        
        // ✅ SMART: Use semantic understanding to detect if message refers to a pickup source
        // (e.g., "my friend's house" in "pickup from my friend's house" is a LOCATION, not delivery intent)
        const pickupReferenceCheck = await this.detectAddressRoleReference(userMessage, 'delivery');
        
        if (pickupReferenceCheck.isPickupReference && !pickupReferenceCheck.containsDeliveryLocation) {
          this.logger.log(`⚠️ Message refers to pickup source, not delivery location - asking for delivery (semantic: ${pickupReferenceCheck.reason})`);
          context.data._last_response = `📍 Great! Now where should we **deliver** the parcel?\n\n[BTN|📍 Share Delivery Location|__LOCATION__]\n\nShare delivery location or type address`;
          return {
            success: true,
            output: null,
            event: 'waiting_for_input',
          };
        }
        
        // For location messages, check if coordinates are different
        // Otherwise location-based deliveries would be blocked
        if (userMessage === '__LOCATION__') {
          // Re-fetch session to get the LATEST location (just saved by chat gateway)
          const freshSession = await this.sessionService.getSession(context._system.sessionId);
          const newLocation = freshSession?.data?._user_location || context.data._user_location;
          const pickupLat = pickup.latitude || pickup.lat;
          const pickupLng = pickup.longitude || pickup.lng;
          
          this.logger.log(`📍 Checking delivery location: new=(${newLocation?.latitude}, ${newLocation?.longitude}) vs pickup=(${pickupLat}, ${pickupLng})`);
          
          // If we have a new location with different coordinates, it's a valid delivery location
          if (newLocation && (newLocation.latitude !== pickupLat || newLocation.longitude !== pickupLng)) {
            this.logger.log('✅ New delivery location received (different from pickup)');
            // Continue processing - don't block
          } else if (newLocation && Math.abs(newLocation.latitude - pickupLat) < 0.0001 && Math.abs(newLocation.longitude - pickupLng) < 0.0001) {
            // Use small threshold for floating point comparison
            this.logger.log('⚠️ Same location as pickup - asking for different delivery location...');
            context.data._last_response = `📍 Please share a different delivery location:\n\n[BTN|📍 Share Location|__LOCATION__]\n\nThe delivery location should be different from pickup.`;
            return {
              success: true,
              output: null,
              event: 'waiting_for_input',
            };
          } else {
            // No new location yet, ask for it WITH saved addresses
            this.logger.log('Waiting for delivery location - offering saved addresses...');
            
            // Fetch saved addresses to offer as options
            if (allowSaved && userId && authToken) {
              const savedAddresses = await this.phpAddressService.getAddresses(authToken);
              if (savedAddresses && savedAddresses.length > 0) {
                context.data[`${field}_offered`] = true;
                context.data[`${field}_options`] = savedAddresses;
                
                const addressButtons = savedAddresses.map((addr, idx) => {
                  const emoji = this.phpAddressService.getAddressTypeEmoji(addr.addressType);
                  const shortAddr = addr.address?.length > 28 ? addr.address.substring(0, 28) + '...' : addr.address;
                  return `[BTN|${emoji} ${addr.addressType || 'Saved'} - ${shortAddr}|${idx + 1}]`;
                }).join('\n');

                context.data._last_response = `📍 Where should we deliver?\n\nChoose a saved address:\n${addressButtons}\n\n[BTN|📍 Share New Location|__LOCATION__]`;
                return {
                  success: true,
                  output: null,
                  event: 'waiting_for_input',
                };
              }
            }
            
            context.data._last_response = `📍 Share your delivery location:\n\n[BTN|📍 Share Location|__LOCATION__]\n\nOr type address / paste Google Maps link`;
            return {
              success: true,
              output: null,
              event: 'waiting_for_input',
            };
          }
        } else if (pickupInput && pickupInput === userMessage) {
          this.logger.log('Message already used for pickup - offering saved addresses for delivery...');
          
          // Fetch saved addresses to offer as options
          if (allowSaved && userId && authToken) {
            const savedAddresses = await this.phpAddressService.getAddresses(authToken);
            if (savedAddresses && savedAddresses.length > 0) {
              context.data[`${field}_offered`] = true;
              context.data[`${field}_options`] = savedAddresses;
              
              const addressButtons = savedAddresses.map((addr, idx) => {
                const emoji = this.phpAddressService.getAddressTypeEmoji(addr.addressType);
                const shortAddr = addr.address?.length > 28 ? addr.address.substring(0, 28) + '...' : addr.address;
                return `[BTN|${emoji} ${addr.addressType || 'Saved'} - ${shortAddr}|${idx + 1}]`;
              }).join('\n');

              context.data._last_response = `📍 Where should we deliver?\n\nChoose a saved address:\n${addressButtons}\n\n[BTN|📍 Share New Location|__LOCATION__]`;
              return {
                success: true,
                output: null,
                event: 'waiting_for_input',
              };
            }
          }
          
          context.data._last_response = `📍 Share your delivery location:\n\n[BTN|📍 Share Location|__LOCATION__]\n\nOr type address / paste Google Maps link`;

          return {
            success: true,
            output: null,
            event: 'waiting_for_input',
          };
        }
      }

      // Step 1: Check if user is requesting saved address but NOT authenticated
      // 🔧 FIX: Use isAuthenticated to include Google OAuth users
      if (allowSaved && !isAuthenticated) {
        const messageLower = userMessage.toLowerCase();
        
        // Hindi/Hinglish keyword mapping for saved address types
        const savedAddressKeywords = [
          'my home', 'mera ghar', 'mere ghar', 'apna ghar', 'apne ghar', 'ghar', 'घर',
          'my office', 'mera office', 'mere office', 'office', 'ऑफिस', 'kaam', 'काम',
          'saved address', 'save address', 'bachaya hua', 'pehle wala', 'purana',
        ];
        
        const mentionsSavedAddress = savedAddressKeywords.some(keyword => 
          messageLower.includes(keyword)
        );
        
        if (mentionsSavedAddress) {
          this.logger.log(`🔐 User mentioned saved address "${userMessage}" but not authenticated - offering login`);
          
          context.data._last_response = `🔐 To use your saved addresses (Home, Office, etc.), please login first:\n\n[BTN|🔑 Login to Continue|trigger_auth_flow]\n\nOr share a new location:\n[BTN|📍 Share Location|__LOCATION__]`;
          
          return {
            success: true,
            output: null,
            event: 'waiting_for_input',
          };
        }
      }

      // Step 2: Offer saved addresses if user is authenticated
      if (allowSaved && userId && authToken) {
        const savedAddresses = await this.phpAddressService.getAddresses(authToken);

        if (savedAddresses && savedAddresses.length > 0 && !context.data[`${field}_offered`]) {
          // Check for smart match first (Step 2b logic moved here for efficiency)
          const messageLower = userMessage.toLowerCase();
          
          // Hindi/Hinglish keyword mapping for address types
          const addressTypeAliases: Record<string, string[]> = {
            'home': ['ghar', 'घर', 'mera ghar', 'mere ghar', 'apna ghar', 'apne ghar', 'house', 'residence', 'my home'],
            'office': ['office', 'ऑफिस', 'kaam', 'काम', 'work', 'workplace', 'daftar', 'दफ्तर'],
            'other': ['dost', 'friend', 'relative', 'rishtedaar', 'रिश्तेदार'],
          };
          
          const matched = savedAddresses.find(addr => {
            const addrType = (addr.addressType || '').toLowerCase();
            const addrAddress = (addr.address || '').toLowerCase();
            
            // Direct type match
            const typeMatch = addrType && (
              addrType === messageLower ||
              messageLower.includes(addrType)
            );
            
            // Hindi alias match - check if message contains any Hindi word for this address type
            const aliasMatch = Object.entries(addressTypeAliases).some(([type, aliases]) => {
              if (addrType.includes(type)) {
                return aliases.some(alias => messageLower.includes(alias));
              }
              return false;
            });
            
            const nameMatch = addr.contactPersonName && (
              messageLower.includes(addr.contactPersonName.toLowerCase())
            );
            
            // "X wala" pattern matching - e.g., "42 wala", "college wala"
            // Extract numbers or words before "wala" and check if address contains them
            const walaMatch = (() => {
              const walaPattern = /(\d+|[a-z]+)\s*wala/i;
              const match = messageLower.match(walaPattern);
              if (match) {
                const searchTerm = match[1]; // The number or word before "wala"
                // Check if the saved address contains this number/word
                return addrAddress.includes(searchTerm) || 
                       addrAddress.includes(searchTerm + ',') ||
                       addrAddress.includes(searchTerm + ' ');
              }
              return false;
            })();
            
            return typeMatch || aliasMatch || nameMatch || walaMatch;
          });

          if (matched) {
            const addressData = {
              address: matched.address,
              latitude: parseFloat(matched.latitude),
              longitude: parseFloat(matched.longitude),
              contact_person_name: matched.contactPersonName,
              contact_person_number: matched.contactPersonNumber,
              address_id: matched.id,
              source: 'saved_address',
              source_message: userMessage, // Store original message for duplicate detection
            };

            context.data[field] = addressData;
            context.data._last_response = `✅ Using your saved address for ${matched.contactPersonName || matched.addressType}: ${matched.address}`;

            return {
              success: true,
              output: addressData,
              event: 'address_valid',
            };
          }

          // If no smart match, offer the list as cards/buttons
          context.data[`${field}_offered`] = true;
          context.data[`${field}_options`] = savedAddresses;

          const locationLabel = field.includes('pickup') || field.includes('sender') ? 'pickup' : 'delivery';
          const locationEmoji = locationLabel === 'pickup' ? '📦' : '📍';
          
          // Build address buttons for quick selection using | separator to avoid colon conflicts
          const addressButtons = savedAddresses.map((addr, idx) => {
            const emoji = this.phpAddressService.getAddressTypeEmoji(addr.addressType);
            const shortAddr = addr.address?.length > 28 ? addr.address.substring(0, 28) + '...' : addr.address;
            return `[BTN|${emoji} ${addr.addressType || 'Saved'} - ${shortAddr}|${idx + 1}]`;
          }).join('\n');

          context.data._last_response = `${locationEmoji} **Select ${locationLabel.toUpperCase()} Location**\n\nChoose from your saved addresses:\n${addressButtons}\n\n[BTN|📍 Share New Location|__LOCATION__]\n[BTN|❌ Cancel|cancel]`;

          return {
            success: true, // Successfully offered addresses
            output: null,
            event: 'waiting_for_input',
          };
        }
      }

      // Step 2: Check if user selected from saved addresses (by number OR by name)
      if (context.data[`${field}_options`]) {
        const options = context.data[`${field}_options`] as any[];
        let selected = null;

        // Try numeric selection first
        const selection = parseInt(userMessage);
        if (!isNaN(selection) && selection >= 1 && selection <= options.length) {
          selected = options[selection - 1];
        } else {
          // Try matching by address type (home, office, work, etc.) OR contact person name
          // Also support Hindi/Hinglish words like "ghar" for "home"
          const messageLower = userMessage.toLowerCase();
          
          // Hindi/Hinglish keyword mapping for address types
          const addressTypeAliases: Record<string, string[]> = {
            'home': ['ghar', 'घर', 'mera ghar', 'mere ghar', 'apna ghar', 'apne ghar', 'house', 'residence'],
            'office': ['office', 'ऑफिस', 'kaam', 'काम', 'work', 'workplace', 'daftar', 'दफ्तर'],
            'other': ['dost', 'friend', 'relative', 'rishtedaar', 'रिश्तेदार'],
          };
          
          const typeMatch = options.find(addr => {
            const addrType = (addr.addressType || '').toLowerCase();
            
            // Direct match
            if ((addrType && addrType === messageLower) ||
                (addrType && messageLower.includes(addrType)) ||
                (addr.contactPersonName && addr.contactPersonName.toLowerCase().includes(messageLower))) {
              return true;
            }
            
            // Hindi alias match
            return Object.entries(addressTypeAliases).some(([type, aliases]) => {
              if (addrType.includes(type)) {
                return aliases.some(alias => messageLower.includes(alias));
              }
              return false;
            });
          });
          if (typeMatch) {
            selected = typeMatch;
          }
        }

        if (selected) {
          const lat = parseFloat(selected.latitude);
          const lng = parseFloat(selected.longitude);

          // Saved addresses without coordinates (e.g. "Other" type, manually typed) cannot be zone-validated
          if (isNaN(lat) || isNaN(lng) || lat === 0 || lng === 0) {
            this.logger.warn(`Saved address "${selected.address}" has no coordinates (lat=${selected.latitude}, lng=${selected.longitude}) — asking user to share location`);
            const shortAddr = selected.address?.substring(0, 50) || 'this address';
            context.data._last_response = `📍 "${shortAddr}" doesn't have location coordinates saved.\n\nPlease share your live location or type a full address so we can verify delivery is available.`;
            delete context.data[`${field}_options`];
            delete context.data[`${field}_offered`];
            return {
              success: false,
              event: 'address_invalid',
              error: 'Address has no coordinates',
            };
          }

          const addressData = {
            address: selected.address,
            latitude: lat,
            longitude: lng,
            contact_person_name: selected.contactPersonName,
            contact_person_number: selected.contactPersonNumber,
            address_id: selected.id,
            source: 'saved_address',
            raw_input: userMessage,
          };

          context.data[field] = addressData;
          delete context.data[`${field}_options`];
          delete context.data[`${field}_offered`];

          context.data._last_response = `✅ Using saved address: ${selected.address}`;

          // Phase 2: Record successful address selection
          await this.recordAddressInteraction(userMessage, true, context);

          return {
            success: true,
            output: addressData,
            event: 'address_valid',
          };
        }
        
        // If user message is too short/generic (not an address), re-offer saved addresses
        // Words like "parcel", "yes", "ok", "haan" are not addresses
        const genericKeywords = ['parcel', 'yes', 'ok', 'no', 'haan', 'ji', 'nahi', 'book', 'send', 'delivery', 'pickup', 'bhej'];
        const isGenericMessage = userMessage.length < 10 || genericKeywords.some(kw => userMessage.toLowerCase() === kw);
        
        if (isGenericMessage) {
          this.logger.log(`🔄 Re-offering saved addresses - user message too generic: "${userMessage}"`);
          const locationLabel = field.includes('pickup') || field.includes('sender') ? 'PICKUP' : 'DELIVERY';
          const locationEmoji = locationLabel === 'PICKUP' ? '📦' : '📍';
          
          const addressButtons = options.map((addr, idx) => {
            const emoji = this.phpAddressService.getAddressTypeEmoji(addr.addressType);
            const shortAddr = addr.address?.length > 28 ? addr.address.substring(0, 28) + '...' : addr.address;
            return `[BTN|${emoji} ${addr.addressType || 'Saved'} - ${shortAddr}|${idx + 1}]`;
          }).join('\n');

          context.data._last_response = `${locationEmoji} **Select ${locationLabel} Location**\n\nPlease choose an address:\n${addressButtons}\n\n[BTN|📍 Share New Location|__LOCATION__]\n[BTN|❌ Cancel|cancel]`;

          return {
            success: true,
            output: null,
            event: 'waiting_for_input',
          };
        }
      }

      // Step 2b: REMOVED (Merged into Step 1)

      // Step 3: Check for location share from session
      // IMPORTANT: Only consume session location when the user explicitly shared location.
      // Otherwise we can accidentally reuse a previous location (e.g., pickup) for delivery.
      const wantsLocationShare = !userMessage || userMessage === '__LOCATION__';
      if (wantsLocationShare && session?.data?.location && session.data.lastLocationUpdate) {
        const locationAge = Date.now() - session.data.lastLocationUpdate;

        if (locationAge < 60000) { // Within last 60 seconds
          const { lat, lng } = session.data.location;

          // If we're collecting delivery after pickup, prevent silently reusing the same location.
          if (field === 'delivery_address' && context.data.pickup_address) {
            const pickup = context.data.pickup_address;
            const pickupLat = pickup.latitude || pickup.lat;
            const pickupLng = pickup.longitude || pickup.lng;

            if (
              typeof pickupLat === 'number' &&
              typeof pickupLng === 'number' &&
              Math.abs(lat - pickupLat) < 0.0001 &&
              Math.abs(lng - pickupLng) < 0.0001
            ) {
              this.logger.log('⚠️ Delivery location matches pickup - requesting a different delivery location');
              context.data._last_response = `📍 Please share a different delivery location:\n\n[BTN|📍 Share Location|__LOCATION__]\n\nOr type address / paste Google Maps link`;
              return {
                success: true,
                output: null,
                event: 'waiting_for_input',
              };
            }
          }

          // ✅ FIX: Call reverseGeocode to get readable address from coordinates
          this.logger.log(`📍 Extracting address from location: (${lat}, ${lng})`);
          const extraction = await this.addressExtraction.extractAddress(userMessage || '__LOCATION__', {
            city: this.configService.get('geo.defaultCity', 'Nashik'),
            userLocation: { lat, lng },
          });

          let readableAddress = 'Shared location';
          if (extraction.success && extraction.address?.address) {
            readableAddress = extraction.address.address;
            this.logger.log(`✅ Reverse geocoded to: ${readableAddress}`);
          } else {
            this.logger.warn(`⚠️ Reverse geocoding failed, using coordinates`);
            readableAddress = `Location at ${lat.toFixed(6)}, ${lng.toFixed(6)}`;
          }

          const addressData = {
            address: readableAddress,
            latitude: lat,
            longitude: lng,
            source: 'location_share',
            raw_input: userMessage,
          };

          context.data[field] = addressData;
          context.data._last_response = `✅ Location received: ${addressData.address}`;

          return {
            success: true,
            output: addressData,
            event: 'address_valid',
          };
        }
      }

      // Step 4: TRY ADDRESS EXTRACTION FIRST (before question detection)
      // CRITICAL: If message contains address indicators, prioritize extraction over question detection
      const hasAddressIndicators = 
        /maps\.app|maps\.google|goo\.gl|coordinates|lat.*lng|\d{1,3}\.\d{6}/.test(userMessage) || // Maps links or coordinates
        /\d{10}/.test(userMessage) || // Phone numbers
        /(pickup|delivery|address|location|place|ghar|office|home)/i.test(userMessage); // Address keywords

      this.logger.debug(`🔍 Address indicators present: ${hasAddressIndicators}`);

      // Step 5: Extract address from message (now happens BEFORE question check)
      let extraction = await this.addressExtraction.extractAddress(userMessage, {
        city: this.configService.get('geo.defaultCity', 'Nashik'),
        userLocation: session?.data?.location,
      });

      // If extraction succeeded OR message has strong address indicators, use the extracted address
      if (extraction.success && extraction.address) {
        const addr = extraction.address;

        if (requireCoordinates && (!addr.latitude || !addr.longitude)) {
          context.data._last_response = `Got "${addr.address}" - need exact location:\n\n[BTN|📍 Share Location|__LOCATION__]\n\nOr paste Google Maps link`;

          return {
            success: true, // Successfully asked for coordinates
            output: null,
            event: 'waiting_for_input',
          };
        }

        const addressData = {
          address: addr.address,
          latitude: addr.latitude,
          longitude: addr.longitude,
          source: addr.source,
          raw_input: userMessage,
          ...addr.metadata,
        };

        this.logger.log(`✅ Address extracted successfully: ${addr.address.substring(0, 50)}...`);

        // Phase 2: Analyze user sentiment during address collection
        try {
          const sentiment = await this.sentimentAnalysis.analyze(userMessage, {
            conversation_history: context.data._conversation_history || [],
            flow_stage: 'address_collection',
          });

          this.logger.debug(`😊 Sentiment: ${sentiment.emotion}, frustration: ${sentiment.frustration_score.toFixed(2)}`);

          // Phase 2: Record training data for continuous learning
          await this.advancedLearning.recordTrainingData({
            message: userMessage,
            questionType: 'address_input',
            actualClassification: true, // Successfully extracted address
            predictedClassification: true,
            confidence: 0.95,
            flowContext: 'parcel_delivery',
            language: this.detectLanguage(userMessage),
            userId: userId,
            sessionId: context._system.sessionId,
          });

          // If user is frustrated, offer proactive support
          if (sentiment.frustration_score > 0.7) {
            this.logger.log(`🚨 High frustration detected (${sentiment.frustration_score.toFixed(2)}) - offering support`);
            context.data._last_response = `✅ Address confirmed: ${addr.address}\n\n🤝 I sense you might need help. Would you like me to connect you with our support team?`;
          } else {
            context.data._last_response = `✅ Address confirmed: ${addr.address}`;
          }
        } catch (error) {
          this.logger.warn(`Phase 2 analysis failed: ${error.message}`);
          context.data._last_response = `✅ Address confirmed: ${addr.address}`;
        }

        context.data[field] = addressData;

        return {
          success: true,
          output: addressData,
          event: 'address_valid',
        };
      }

      // Step 6: ONLY NOW check if it's a question (if address extraction failed)
      // Check if user is asking a question instead of providing an address
      const questionResult = await this.questionClassifier.classify(userMessage, {
        current_step: field,
        flow_type: context._system.flowId,
        conversation_history: context.data._conversation_history || [],
      });
      
      if (questionResult.isQuestion && questionResult.confidence > 0.6) {
        this.logger.log(`🧠 Question detected: type=${questionResult.type}, confidence=${questionResult.confidence.toFixed(2)}`);
        
        // ✅ NEW: Check if user already asked this before (avoid repetition)
        const memoryCheck = await this.conversationMemory.findRepeatedQuestion(
          userMessage,
          context.data._conversation_history || []
        );
        
        let response: string;
        
        if (memoryCheck.isRepeated && memoryCheck.previousAnswer) {
          // User asked this before - give brief reminder + previous answer
          response = `I answered this earlier! Here's what I said:\n\n${memoryCheck.previousAnswer}`;
          this.logger.log(`🔁 Repeated question detected (similarity: ${memoryCheck.similarity?.toFixed(2)})`);
        } else {
          // ✅ NEW: Generate intelligent context-aware response using LLM
          response = await this.intelligentResponse.generate(userMessage, questionResult, {
            current_field: field,
            flow_id: context._system.flowId,
            collected_data: context.data,
            conversation_history: context.data._conversation_history || [],
            user_id: userId,
            session_id: context._system.sessionId,
          });
        }
        
        // Update conversation history so downstream steps have context
        if (!context.data._conversation_history) {
          context.data._conversation_history = [];
        }
        context.data._conversation_history.push(
          { role: 'user', content: userMessage, type: 'question' },
          { role: 'assistant', content: response, type: 'answer' },
        );
        if (context.data._conversation_history.length > 40) {
          context.data._conversation_history = context.data._conversation_history.slice(-40);
        }

        context.data._last_response = response;
        this.logger.log(`💬 Generated response: ${response.substring(0, 100)}...`);
        
        return {
          success: true,
          output: null,
          event: 'waiting_for_input', // Stay in same state, waiting for actual address
        };
      }

      // Step 7: Ask for address (both extraction and question detection failed)
      const locationLabel = field.includes('pickup') || field.includes('sender') 
        ? 'PICKUP' 
        : 'DELIVERY';
      const locationEmoji = locationLabel === 'PICKUP' ? '📦' : '📍';

      // Phase 2: Analyze sentiment for failed extraction (user might be frustrated)
      try {
        const sentiment = await this.sentimentAnalysis.analyze(userMessage, {
          conversation_history: context.data._conversation_history || [],
          flow_stage: 'address_collection_retry',
        });

        // Record failed address extraction for learning
        await this.advancedLearning.recordTrainingData({
          message: userMessage,
          questionType: 'address_input',
          actualClassification: false, // Failed to extract
          predictedClassification: false,
          confidence: 0.3,
          flowContext: 'parcel_delivery',
          language: this.detectLanguage(userMessage),
          userId: userId,
          sessionId: context._system.sessionId,
        });

        if (sentiment.frustration_score > 0.7) {
          this.logger.log(`🚨 User frustrated after failed address extraction`);
          context.data._last_response = `${locationEmoji} I'm having trouble understanding that address.\n\n🤝 Let me help - please share your location or type the full address:\n\n[BTN|📍 Share Location|__LOCATION__]\n[BTN|💬 Chat with Support|support]\n[BTN|❌ Cancel|cancel]`;
        } else {
          context.data._last_response = `${locationEmoji} **Where is the ${locationLabel} location?**\n\nShare your location or type an address:\n\n[BTN|📍 Share Location|__LOCATION__]\n[BTN|❌ Cancel|cancel]`;
        }
      } catch (error) {
        this.logger.warn(`Phase 2 sentiment analysis failed: ${error.message}`);
        context.data._last_response = `${locationEmoji} **Where is the ${locationLabel} location?**\n\nShare your location or type an address:\n\n[BTN|📍 Share Location|__LOCATION__]\n[BTN|❌ Cancel|cancel]`;
      }

      return {
        success: true, // Successfully asked for input
        output: null,
        event: 'waiting_for_input',
      };
    } catch (error) {
      this.logger.error(`Address execution failed: ${error.message}`, error.stack);
      context.data._friendly_error = "I had trouble processing your address. Could you try sharing your location using the button below, or type the full address again?";
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Phase 2: Detect language of user message for training data
   */
  private detectLanguage(message: string): 'en' | 'hi' | 'hinglish' {
    const hindiPattern = /[\u0900-\u097F]/; // Devanagari script
    const hinglishKeywords = /\b(kya|hai|ho|ji|bhai|dost|acha|thik|sahi|nahi|haan|accha|theek|bolo|batao|samjha)\b/i;

    if (hindiPattern.test(message)) {
      return 'hi';
    } else if (hinglishKeywords.test(message)) {
      return 'hinglish';
    }
    return 'en';
  }

  /**
   * Phase 2: Record address interaction for training
   */
  private async recordAddressInteraction(userMessage: string, success: boolean, context: FlowContext): Promise<void> {
    try {
      if (!userMessage) return;

      const sentiment = await this.sentimentAnalysis.analyze(userMessage, {
        conversation_history: context.data._conversation_history || [],
        flow_stage: 'address_collection',
      });

      await this.advancedLearning.recordTrainingData({
        message: userMessage,
        questionType: 'address_extraction',
        actualClassification: success,
        predictedClassification: success,
        confidence: success ? 0.9 : 0.3,
        flowContext: 'address_collection',
        language: this.detectLanguage(userMessage),
        userId: context._system?.userId || 'unknown',
        sessionId: context._system?.sessionId || 'unknown',
      });

      if (!success && sentiment.frustration_score > 0.7) {
        this.logger.log(`😤 Address frustration: extraction failed, frustration: ${sentiment.frustration_score.toFixed(2)}`);
      }
    } catch (error) {
      this.logger.warn(`Phase 2 address tracking failed: ${error.message}`);
    }
  }

  /**
   * 🧠 SEMANTIC ADDRESS ROLE DETECTION
   * 
   * Uses LLM to intelligently understand the semantic meaning of the user's message
   * and determine if it refers to a pickup source, delivery destination, or contains
   * an actual address.
   * 
   * Examples:
   * - "pickup from my friend's house" → isPickupReference: true (friend's house = pickup location)
   * - "deliver to my office" → isPickupReference: false, containsDeliveryLocation: true
   * - "123 Main Street" → isPickupReference: false, containsDeliveryLocation: true (plain address)
   * 
   * This replaces the old regex-based keyword detection that couldn't understand context.
   */
  private async detectAddressRoleReference(
    userMessage: string,
    expectedRole: 'pickup' | 'delivery'
  ): Promise<{
    isPickupReference: boolean;
    containsDeliveryLocation: boolean;
    extractedLocation: string | null;
    reason: string;
  }> {
    // Quick fallback for very short/empty messages
    if (!userMessage || userMessage.length < 3) {
      return {
        isPickupReference: false,
        containsDeliveryLocation: false,
        extractedLocation: null,
        reason: 'empty_message',
      };
    }

    // Quick pattern check for obvious delivery addresses (coordinates, map links)
    const isObviousAddress = /maps\.app|goo\.gl|google\.com\/maps|\d{1,3}\.\d{4,}/.test(userMessage);
    if (isObviousAddress) {
      return {
        isPickupReference: false,
        containsDeliveryLocation: true,
        extractedLocation: userMessage,
        reason: 'obvious_address_pattern',
      };
    }

    try {
      // Use LLM for semantic understanding
      const prompt = `Analyze this message for a parcel delivery service. The user is being asked for their ${expectedRole} address.

User message: "${userMessage}"

Determine:
1. Is the user DESCRIBING where to pickup FROM (e.g., "from my friend's house", "pickup at office")? 
2. Or is the user PROVIDING a delivery destination (e.g., "my home", "123 Main St", just an address)?
3. What location/place is mentioned?

IMPORTANT: 
- "pickup from X" or "collect from X" means X is the PICKUP source, not delivery
- "deliver to X" or just "X" (an address) means X is the DELIVERY destination
- If message contains both source and destination, identify which is which

Respond in JSON format:
{
  "is_describing_pickup_source": true/false,
  "contains_delivery_destination": true/false,
  "location_mentioned": "the place name or address mentioned, or null",
  "reasoning": "brief explanation"
}`;

      const result = await this.llmService.chat({
        messages: [
          { role: 'system', content: 'You are an address role classifier for a delivery service. Respond only with valid JSON.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.1,
        maxTokens: 200,
      });

      const responseText = result.content || '';
      
      // Parse JSON from response
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        this.logger.debug(`🧠 Semantic role detection: ${JSON.stringify(parsed)}`);
        
        return {
          isPickupReference: parsed.is_describing_pickup_source === true,
          containsDeliveryLocation: parsed.contains_delivery_destination === true,
          extractedLocation: parsed.location_mentioned || null,
          reason: parsed.reasoning || 'llm_analysis',
        };
      }
    } catch (error) {
      this.logger.warn(`LLM semantic detection failed: ${error.message}, using fallback`);
    }

    // Fallback: Smart keyword analysis with context
    const messageLower = userMessage.toLowerCase();
    
    // Phrases that indicate the user is describing WHERE TO PICK UP FROM
    const pickupSourcePhrases = [
      /pickup\s+from\s+/i,
      /pick\s+up\s+from\s+/i,
      /collect\s+from\s+/i,
      /get\s+(it\s+)?from\s+/i,
      /uthao\s+/i,
      /lene\s+/i,
      /le\s+lo\s+/i,
      /yahan\s+se\s+/i,
      /from\s+(my|the|this)\s+/i,
    ];
    
    // Phrases that indicate delivery destination
    const deliveryDestPhrases = [
      /deliver\s+to\s+/i,
      /send\s+to\s+/i,
      /bhej\s+(do\s+)?/i,
      /pahunchao\s+/i,
    ];
    
    const hasPickupPhrase = pickupSourcePhrases.some(p => p.test(messageLower));
    const hasDeliveryPhrase = deliveryDestPhrases.some(p => p.test(messageLower));
    
    // Check for standalone address indicators (no source/dest phrases = just an address)
    const hasAddressIndicators = /\d{2,}|road|street|nagar|colony|chowk|near|opposite|behind|floor|flat/i.test(messageLower);
    
    return {
      isPickupReference: hasPickupPhrase && !hasDeliveryPhrase,
      containsDeliveryLocation: hasDeliveryPhrase || (!hasPickupPhrase && hasAddressIndicators),
      extractedLocation: null,
      reason: 'fallback_pattern_matching',
    };
  }

  /**
   * Detect if the message is a parcel booking trigger (not a direct address input)
   * These messages describe the INTENT to book, not the actual address
   * e.g., "need to pickup a parcel from my friends house to my house"
   */
  private isParcelBookingTriggerMessage(message: string): boolean {
    if (!message || message.length < 10) return false;
    
    const messageLower = message.toLowerCase().trim();
    
    // Patterns that indicate this is a flow trigger, not a direct address
    const triggerPatterns = [
      // "need to pickup/send/deliver a parcel"
      /\b(need|want|have)\s+(to\s+)?(pickup|pick up|send|deliver|courier|bhej)/i,
      // "pickup parcel from X to Y"
      /\b(pickup|pick up|parcel|courier)\s+(from|se)\s+.*(to|ko|tak)\s+/i,
      // "send from X to Y"
      /\b(send|bhej|deliver)\s+(from|se)\s+.*(to|ko|tak)\s+/i,
      // Hindi patterns
      /\b(mujhe|chahiye|bhejn|bhejna|lena)\b.*\b(parcel|courier|saman|cheez)/i,
      // Contains both "from" and "to" with locations
      /\bfrom\s+(my|a|the)\s+\w+.*\bto\s+(my|a|the)\s+/i,
      // "parcel from friend's house"
      /\b(parcel|courier|package)\s+from\s+/i,
    ];
    
    // If it matches any trigger pattern, it's NOT a direct address
    const isTrigger = triggerPatterns.some(p => p.test(messageLower));
    
    if (isTrigger) {
      this.logger.debug(`🎯 Detected parcel booking trigger: "${message}"`);
    }
    
    return isTrigger;
  }

  /**
   * 🧠 Extract address type hint from a parcel booking trigger message
   * e.g., "need to send a parcel from my home" → "home"
   *        "ghar se parcel bhejo" → "home"
   *        "office se pickup karo" → "office"
   */
  private extractAddressHintFromTrigger(message: string): string | null {
    if (!message) return null;
    const msg = message.toLowerCase();

    // Map of patterns to normalized address types
    const hintPatterns: Array<{ patterns: RegExp[]; type: string }> = [
      {
        type: 'home',
        patterns: [
          /\b(from|se)\s+(my\s+)?(home|ghar|house|घर|residence)\b/i,
          /\b(my|mera|mere|apna|apne)\s+(home|ghar|house|घर)\b/i,
          /\b(home|ghar|घर)\s+(se|from)\b/i,
        ],
      },
      {
        type: 'office',
        patterns: [
          /\b(from|se)\s+(my\s+)?(office|daftar|दफ्तर|workplace|work)\b/i,
          /\b(my|mera|mere|apna|apne)\s+(office|daftar|दफ्तर|work)\b/i,
          /\b(office|daftar|दफ्तर)\s+(se|from)\b/i,
        ],
      },
    ];

    for (const { patterns, type } of hintPatterns) {
      if (patterns.some(p => p.test(msg))) {
        this.logger.debug(`🧠 Address hint extracted: "${type}" from "${message}"`);
        return type;
      }
    }

    return null;
  }

  /**
   * 🧠 Extract DELIVERY address type hint from a parcel booking trigger message
   * Extracts the "to" side of the message
   * e.g., "ghar se office bhejo" → "office"
   *        "home se daftar tak parcel" → "office"
   *        "send from home to my office" → "office"
   */
  private extractDeliveryHintFromTrigger(message: string): string | null {
    if (!message) return null;
    const msg = message.toLowerCase();

    const hintPatterns: Array<{ patterns: RegExp[]; type: string }> = [
      {
        type: 'home',
        patterns: [
          /\b(to|ko|tak|pe)\s+(my\s+)?(home|ghar|house|घर|residence)\b/i,
          /\b(deliver|bhej|pahuncha)\w*\s+(my\s+)?(home|ghar|house|घर)\b/i,
        ],
      },
      {
        type: 'office',
        patterns: [
          /\b(to|ko|tak|pe)\s+(my\s+)?(office|daftar|दफ्तर|workplace|work)\b/i,
          /\b(deliver|bhej|pahuncha)\w*\s+(my\s+)?(office|daftar|दफ्तर|work)\b/i,
          // "ghar se office" pattern — office is the destination when preceded by "se/from"
          /\b(se|from)\s+\w+\s+(office|daftar|दफ्तर)\b/i,
          // Explicit "X se office bhejo" — office after source
          /\b(home|ghar|घर)\s+(se|from)\b.*\b(office|daftar|दफ्तर)\b/i,
        ],
      },
    ];

    for (const { patterns, type } of hintPatterns) {
      if (patterns.some(p => p.test(msg))) {
        this.logger.debug(`🧠 Delivery hint extracted: "${type}" from "${message}"`);
        return type;
      }
    }

    return null;
  }

  /**
   * 🧠 Match a saved address by address type hint
   * Returns the first saved address whose addressType matches the hint
   */
  private matchSavedAddressByHint(savedAddresses: any[], hint: string): any | null {
    if (!savedAddresses || !hint) return null;
    const hintLower = hint.toLowerCase();
    
    return savedAddresses.find(addr => {
      const addrType = (addr.addressType || '').toLowerCase();
      return addrType === hintLower;
    }) || null;
  }

  validate(config: Record<string, any>): boolean {
    return !!config.field;
  }
}
