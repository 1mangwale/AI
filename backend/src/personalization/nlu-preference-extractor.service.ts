import { Injectable, Logger } from '@nestjs/common';
import { PreferenceSignal } from './preference-signal.interface';
import { MetricsService } from '../metrics/metrics.service';

/**
 * NLU Preference Extractor
 *
 * Lightweight, rule-based extractor that consumes NER entities + message text
 * and returns PreferenceSignal[].  No LLM calls — pure regex + entity matching.
 *
 * Designed to replace the per-message vLLM call that was in
 * ConversationAnalyzerService.extractFromMessage().
 *
 * Expected latency: <3 ms per invocation.
 */
@Injectable()
export class NluPreferenceExtractorService {
  private readonly logger = new Logger(NluPreferenceExtractorService.name);

  constructor(private readonly metricsService: MetricsService) {}

  // ── Allergen vocabulary ──────────────────────────────────────────────
  private static readonly ALLERGENS = [
    'dairy', 'milk', 'nuts', 'peanuts', 'peanut', 'tree nuts',
    'gluten', 'wheat', 'shellfish', 'shrimp', 'prawn',
    'soy', 'soya', 'eggs', 'egg', 'fish', 'sesame',
  ];

  // ── Public API ───────────────────────────────────────────────────────

  /**
   * Extract preference signals from NER entities and raw message text.
   *
   * @param entities  NER entities from Mercury:7011 — Record<string, string>
   *                  Keys may include: PREF, FOOD, STORE, LOC, QTY, food_items, etc.
   * @param message   Raw user message text
   */
  extractFromNerEntities(
    entities: Record<string, any> | any[],
    message: string,
  ): PreferenceSignal[] {
    const signals: PreferenceSignal[] = [];

    // Normalize entities to Record<string,string> if array
    const entityMap = this.normalizeEntities(entities);

    // 1. Dietary type — from PREF entity or regex
    this.extractDietaryType(entityMap, message, signals);

    // 2. Allergy detection — regex on message
    this.extractAllergies(message, signals);

    // 3. Spice preference — regex on message
    this.extractSpiceLevel(message, signals);

    // 4. Price sensitivity — regex on message
    this.extractPriceSensitivity(message, signals);

    // 5. Favorite items — FOOD entity + affinity context
    this.extractFavorites(entityMap, message, signals);

    if (signals.length > 0) {
      // Record metrics for each extracted signal
      for (const signal of signals) {
        this.metricsService.recordPreferenceSignalExtracted(signal.source);
      }

      this.logger.debug(
        `Extracted ${signals.length} preference signal(s): ${signals.map(s => `${s.key}=${JSON.stringify(s.value)}`).join(', ')}`,
      );
    }

    return signals;
  }

  // ── Private extraction rules ─────────────────────────────────────────

  private extractDietaryType(
    entities: Record<string, string>,
    message: string,
    out: PreferenceSignal[],
  ): void {
    const lower = message.toLowerCase();
    const prefEntity = (entities['PREF'] || '').toLowerCase();

    // Jain must be checked before veg (jain is also vegetarian but more specific)
    if (
      /\b(no\s*onion|no\s*garlic|jain|जैन)\b/i.test(lower) ||
      /jain/i.test(prefEntity)
    ) {
      out.push({ key: 'dietary_type', value: 'jain', confidence: 0.8, source: 'regex' });
      return;
    }

    if (
      /\b(vegan|वीगन)\b/i.test(lower) ||
      /vegan/i.test(prefEntity)
    ) {
      out.push({ key: 'dietary_type', value: 'vegan', confidence: 0.9, source: 'regex' });
      return;
    }

    // Non-veg must be checked before veg
    if (
      /\b(non[\s-]?veg|nonveg|नॉन[\s-]?वेज|maans|maas)\b/i.test(lower) ||
      /non[\s-]?veg/i.test(prefEntity)
    ) {
      out.push({ key: 'dietary_type', value: 'non-vegetarian', confidence: 0.9, source: 'ner' });
      return;
    }

    if (
      /\b(egg(etarian)?|anda|अंडा|both\s*veg\s*and\s*non[\s-]?veg)\b/i.test(lower) ||
      /egg/i.test(prefEntity)
    ) {
      out.push({ key: 'dietary_type', value: 'eggetarian', confidence: 0.85, source: 'regex' });
      return;
    }

    if (
      /\b(veg(etarian)?|शाकाहारी|shakahari|pure\s*veg)\b/i.test(lower) ||
      /veg/i.test(prefEntity)
    ) {
      out.push({ key: 'dietary_type', value: 'vegetarian', confidence: 0.9, source: 'ner' });
      return;
    }
  }

  private extractAllergies(message: string, out: PreferenceSignal[]): void {
    const lower = message.toLowerCase();

    // English patterns
    const enPatterns = [
      /allergic\s+to\s+([\w\s,]+)/i,
      /allergy\s+to\s+([\w\s,]+)/i,
      /can'?t\s+eat\s+([\w\s,]+)/i,
      /intolerant\s+to\s+([\w\s,]+)/i,
      /avoid\s+([\w\s,]+)\s*(due\s+to|because)/i,
    ];

    // Hindi patterns
    const hiPatterns = [
      /([\w\s,]+)\s*se\s+allergy/i,
      /([\w\s,]+)\s*nahi\s+kha\s+sakt[aie]/i,
      /([\w\s,]+)\s*से\s+एलर्जी/i,
      /([\w\s,]+)\s*नहीं\s+खा\s+सकत[ाेी]/i,
    ];

    const allPatterns = [...enPatterns, ...hiPatterns];

    for (const pattern of allPatterns) {
      const match = lower.match(pattern);
      if (match && match[1]) {
        const rawAllergens = match[1].trim();
        const detected = this.matchAllergens(rawAllergens);
        if (detected.length > 0) {
          out.push({
            key: 'allergies',
            value: detected,
            confidence: 0.95,
            source: 'regex',
          });
          return; // one allergy signal per message is enough
        }
      }
    }
  }

  private extractSpiceLevel(message: string, out: PreferenceSignal[]): void {
    const lower = message.toLowerCase();

    // Extra spicy (check first — more specific)
    if (/\b(extra\s*spicy|very\s*spicy|bahut?\s*(teekha|mirchi)|तीखा|zyada\s*mirchi|ज़्यादा\s*मिर्ची)\b/i.test(lower)) {
      out.push({ key: 'spice_level', value: 'hot', confidence: 0.85, source: 'regex' });
      return;
    }

    // Mild / not spicy
    if (/\b(not\s*spicy|mild|kam\s*mirchi|हल्का|halka|no\s*spice|without\s*spice|bina\s*mirchi)\b/i.test(lower)) {
      out.push({ key: 'spice_level', value: 'mild', confidence: 0.85, source: 'regex' });
      return;
    }

    // Medium
    if (/\b(medium\s*spic[ey]|regular\s*spic[ey]|normal\s*spic[ey]|thoda\s*mirchi)\b/i.test(lower)) {
      out.push({ key: 'spice_level', value: 'medium', confidence: 0.75, source: 'regex' });
      return;
    }
  }

  private extractPriceSensitivity(message: string, out: PreferenceSignal[]): void {
    const lower = message.toLowerCase();

    // Budget / cheap
    if (/\b(budget|cheap|sasta|affordable|under\s*\d+|low\s*price|sabse\s*sasta|kuch\s*sasta)\b/i.test(lower)) {
      out.push({ key: 'price_sensitivity', value: 'high', confidence: 0.7, source: 'regex' });
      return;
    }

    // Premium / quality-first
    if (/\b(premium|best\s*quality|doesn'?t?\s*matter|price\s*(no|doesn'?t|not)\s*(issue|matter|problem)|accha\s*wala|mehnga\s*chalega)\b/i.test(lower)) {
      out.push({ key: 'price_sensitivity', value: 'low', confidence: 0.7, source: 'regex' });
      return;
    }
  }

  private extractFavorites(
    entities: Record<string, string>,
    message: string,
    out: PreferenceSignal[],
  ): void {
    // Check for FOOD entity
    const foodEntity = entities['FOOD'] || entities['food_items'];
    if (!foodEntity) return;

    const lower = message.toLowerCase();

    // Affinity keywords near a FOOD entity
    if (/\b(fav(ou?rite)?|love|best|pasand|पसंद|mera\s*fav|always\s*order)\b/i.test(lower)) {
      out.push({
        key: 'favorite_items',
        value: [foodEntity],
        confidence: 0.8,
        source: 'ner',
      });
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  private normalizeEntities(entities: Record<string, any> | any[]): Record<string, string> {
    if (!entities) return {};

    if (Array.isArray(entities)) {
      const map: Record<string, string> = {};
      for (const e of entities) {
        if (e && e.type && e.value) {
          map[e.type] = e.value;
        }
      }
      return map;
    }

    // Already a record — flatten any nested objects
    const map: Record<string, string> = {};
    for (const [k, v] of Object.entries(entities)) {
      if (typeof v === 'string') {
        map[k] = v;
      } else if (Array.isArray(v)) {
        map[k] = v.join(', ');
      } else if (v && typeof v === 'object') {
        map[k] = JSON.stringify(v);
      }
    }
    return map;
  }

  private matchAllergens(raw: string): string[] {
    const words = raw.toLowerCase().split(/[\s,]+/).filter(Boolean);
    const matched: string[] = [];

    for (const allergen of NluPreferenceExtractorService.ALLERGENS) {
      for (const word of words) {
        if (word.includes(allergen) || allergen.includes(word)) {
          // Normalize to canonical name
          const canonical = this.canonicalAllergen(allergen);
          if (!matched.includes(canonical)) {
            matched.push(canonical);
          }
        }
      }
    }
    return matched;
  }

  private canonicalAllergen(raw: string): string {
    const map: Record<string, string> = {
      milk: 'dairy',
      peanut: 'peanuts',
      peanuts: 'peanuts',
      'tree nuts': 'nuts',
      shrimp: 'shellfish',
      prawn: 'shellfish',
      soya: 'soy',
      egg: 'eggs',
    };
    return map[raw] || raw;
  }
}
