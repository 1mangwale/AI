/**
 * PreferenceSignal — lightweight preference data extracted from NER entities + regex.
 *
 * Emitted by NluPreferenceExtractorService (rule-based, no LLM calls).
 * Consumed by UserProfilingService.updateFromSignals() to persist to user_profiles.
 */

export interface PreferenceSignal {
  key: PreferenceSignalKey;
  value: any; // string, string[], etc. depending on key
  confidence: number; // 0-1
  source: 'ner' | 'regex' | 'order' | 'explicit' | 'llm_batch';
}

export type PreferenceSignalKey =
  | 'dietary_type'
  | 'allergies'
  | 'spice_level'
  | 'price_sensitivity'
  | 'favorite_items'
  | 'favorite_stores'
  | 'preferred_meal_times'
  | 'family_size';
