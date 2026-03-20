/**
 * ProfileContext — Unified user context for personalization
 *
 * Aggregates data from multiple sources (PG, MySQL, Redis) into a single
 * coherent profile that drives search boosts, flow adaptations, and
 * communication style.
 */
export interface ProfileContext {
  identity: {
    userId: number;
    phone: string;
    name: string;
    memberSince: string;
    segment: string; // RFM segment from behavioral analytics
  };
  dietary: {
    type: string; // vegetarian, non-vegetarian, jain, vegan, eggetarian
    restrictions: string[];
    allergies: string[];
    spiceLevel: string; // mild, medium, hot, extra_hot
    dislikedIngredients: string[];
  };
  shopping: {
    avgOrderValue: number;
    frequency: number; // orders per month
    favoriteStores: string[];
    favoriteItems: string[];
    recentOrders: Array<{ storeId: string; items: string[]; date: string }>;
  };
  communication: {
    tone: string; // casual, formal, friendly
    language: string; // en, hi, hinglish
    emojiUsage: string; // love, moderate, hate
    preferredMessageLength: string; // brief, detailed
  };
  behavioral: {
    rfmSegment: string;
    churnRisk: number; // 0-1
    healthScore: number; // 0-100
    profileCompleteness: number; // 0-100
  };
  defaults: {
    suggestedAddress: any; // Address object or null
    suggestedPayment: string; // 'upi', 'cod', etc. or null
    suggestedItems: Array<{ name: string; storeId: string }>;
  };
}

/**
 * Search boost subset — lightweight data for search personalization
 */
export interface SearchBoosts {
  boostVeg: boolean;
  boostCuisines: string[];
  priceRange: string; // 'budget', 'mid', 'premium'
  favoriteStores: string[];
}
