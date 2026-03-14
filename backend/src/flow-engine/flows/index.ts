/**
 * Flow Definitions Index
 * 
 * All production flow definitions are exported from here.
 * These flows are loaded into the database on application startup.
 */

import { FlowDefinition } from '../types/flow.types';
import { greetingFlow } from './greeting.flow';
import { helpFlow } from './help.flow';
import { gameIntroFlow } from './game-intro.flow';
import { farewellFlow } from './farewell.flow';
import { chitchatFlow } from './chitchat.flow';
import { feedbackFlow } from './feedback.flow';
import { parcelDeliveryFlow } from './parcel-delivery.flow';
import { foodOrderFlow } from './food-order';
import { ecommerceOrderFlow } from './ecommerce-order.flow';
import { profileFlow } from './profile.flow';
import { authFlow } from './auth.flow';
import { orderTrackingFlow } from './order-tracking.flow';
import { supportFlow } from './support.flow';
import { addressManagementFlow } from './address-management.flow';
import { firstTimeOnboardingFlow } from './first-time-onboarding.flow';
import { campaignActionFlow } from './campaign-action.flow';
import { cartRecoveryFlow } from './cart-recovery.flow';

/**
 * All available flow definitions
 * Ordered by priority (general flows first, then specific services)
 */
export const flowDefinitions: FlowDefinition[] = [
  greetingFlow,      // Priority 100 - First interaction
  authFlow,          // Priority 95 - Authentication
  firstTimeOnboardingFlow, // Priority 100 - First-time user onboarding (triggered programmatically)
  helpFlow,          // Priority 90 - Help requests
  gameIntroFlow,     // Priority 85 - Gamification hook
  farewellFlow,      // Priority 80 - Goodbye messages
  chitchatFlow,      // Priority 75 - Casual conversation
  feedbackFlow,      // Priority 70 - User feedback collection
  parcelDeliveryFlow,
  foodOrderFlow,
  ecommerceOrderFlow,
  orderTrackingFlow, // Priority 65 - Order tracking/history
  supportFlow,       // Priority 60 - Customer support
  profileFlow,
  addressManagementFlow, // Address management
  campaignActionFlow,    // Phase 4: mOS campaign action pipeline
  cartRecoveryFlow,      // Phase 4: Abandoned cart recovery
];

/**
 * Flow definitions mapped by ID for quick access
 */
export const flowDefinitionsById: Record<string, FlowDefinition> = {
  [greetingFlow.id]: greetingFlow,
  [authFlow.id]: authFlow,
  [firstTimeOnboardingFlow.id]: firstTimeOnboardingFlow,
  [helpFlow.id]: helpFlow,
  [gameIntroFlow.id]: gameIntroFlow,
  [farewellFlow.id]: farewellFlow,
  [chitchatFlow.id]: chitchatFlow,
  [feedbackFlow.id]: feedbackFlow,
  [parcelDeliveryFlow.id]: parcelDeliveryFlow,
  [foodOrderFlow.id]: foodOrderFlow,
  [ecommerceOrderFlow.id]: ecommerceOrderFlow,
  [orderTrackingFlow.id]: orderTrackingFlow,
  [supportFlow.id]: supportFlow,
  [profileFlow.id]: profileFlow,
  [addressManagementFlow.id]: addressManagementFlow,
  [campaignActionFlow.id]: campaignActionFlow,
  [cartRecoveryFlow.id]: cartRecoveryFlow,
};

/**
 * Flow definitions mapped by trigger intent
 */
export const flowDefinitionsByTrigger: Record<string, FlowDefinition> = {
  [greetingFlow.trigger]: greetingFlow,
  [authFlow.trigger]: authFlow,
  [helpFlow.trigger]: helpFlow,
  [gameIntroFlow.trigger]: gameIntroFlow,
  [farewellFlow.trigger]: farewellFlow,
  [chitchatFlow.trigger]: chitchatFlow,
  [feedbackFlow.trigger]: feedbackFlow,
  [parcelDeliveryFlow.trigger]: parcelDeliveryFlow,
  [foodOrderFlow.trigger]: foodOrderFlow,
  [ecommerceOrderFlow.trigger]: ecommerceOrderFlow,
  [orderTrackingFlow.trigger]: orderTrackingFlow,
  [supportFlow.trigger]: supportFlow,
  [profileFlow.trigger]: profileFlow,
  'manage_address': addressManagementFlow, // Address management by intent
  [campaignActionFlow.trigger]: campaignActionFlow,
  [cartRecoveryFlow.trigger]: cartRecoveryFlow,
};

/**
 * Get flow definition by ID
 */
export function getFlowById(id: string): FlowDefinition | undefined {
  return flowDefinitionsById[id];
}

/**
 * Get flow definition by trigger intent
 */
export function getFlowByTrigger(trigger: string): FlowDefinition | undefined {
  return flowDefinitionsByTrigger[trigger];
}

/**
 * Get all flows for a specific module
 */
export function getFlowsByModule(module: string): FlowDefinition[] {
  return flowDefinitions.filter(flow => flow.module === module);
}
