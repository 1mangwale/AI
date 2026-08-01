/**
 * Shared food-keyword list used by two safety nets:
 * - IntentRouterService keyword food override (post-classification)
 * - IntentClassifierService pre-LLM short-circuit (skips the slow Gemma
 *   fallback when a food word already decides the intent)
 *
 * ⚠️ DEPRECATED as a primary mechanism: AI-powered SemanticFoodDetectorService
 * is the main detector. This list is the emergency fallback — prefer improving
 * the model over growing the list.
 */
export const FOOD_KEYWORDS_LIST = [
  // Indian food
  'paneer', 'biryani', 'chicken', 'mutton', 'dal', 'roti', 'naan', 'thali',
  'paratha', 'kulcha', 'tikka', 'kebab', 'curry', 'masala', 'momos',
  'dosa', 'idli', 'sambar', 'vada', 'uttapam', 'pulao',
  'manchurian', 'chowmein', 'fried rice',
  // Western food
  'burger', 'pizza', 'sandwich', 'fries', 'pasta', 'noodles',
  // Beverages & desserts
  'soup', 'starter', 'dessert', 'shake', 'juice', 'lassi', 'coffee', 'tea',
  // Breakfast items
  'egg', 'anda', 'aanda', 'omelette', 'omlet', 'bhurji',
  // Generic food terms
  'khana', 'khane', 'breakfast', 'lunch', 'dinner', 'snack',
  'quick bite', 'bite', 'kuch khana', 'kuch khane', 'bhook', 'hungry', 'hungry hai',
  'food', 'eat', 'order food', 'want to eat', 'looking for food',
  // Establishment types (indicates food order intent)
  'cafe', 'restaurant', 'hotel', 'dhaba', 'eatery',
  // 🍽️ Maharashtra / Nashik local dishes (critical for local market)
  'misal', 'missal', 'misal pav', 'missal pav', 'poha', 'sabudana', 'vada pav', 'pav bhaji',
  'bhakri', 'zunka', 'thalipeeth', 'kanda poha', 'batata vada',
  'puran poli', 'modak', 'ukadiche modak', 'dhokla', 'khandvi',
  'pithla', 'shevaya', 'upma', 'sheera', 'puri', 'bhel', 'sev puri', 'ragda',
  'plate', 'half plate', 'full plate',  // Quantity + food indicators (ordering context)
  // 🛒 Weight-sold items (dry goods, sweets, spices) - often ordered by gram/kg
  'gulkand', 'murabba', 'chyawanprash', 'namkeen', 'farsan', 'mixture', 'chivda',
  'pedha', 'barfi', 'ladoo', 'halwa', 'chakli', 'shankarpale', 'karanji',
  'aamchur', 'jeera', 'mirchi', 'masala', 'chutney', 'pickle', 'achar',
];

/**
 * Parcel context hints — when present, the food short-circuit must NOT fire
 * (mirrors the parcel guard inside IntentRouterService's food override).
 */
export const PARCEL_HINT_REGEX = /\b(parcel|courier|pickup|package)\b|\bse\b.*\btak\b|\bfrom\b.*\bto\b.*\bdeliver/i;
