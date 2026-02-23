import { Injectable, Logger, Optional } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { ActionExecutor, ActionExecutionResult, FlowContext } from '../types/flow.types';

/**
 * Voice Executor - TTS synthesis and voice input extraction
 *
 * Actions:
 *   tts_respond   - Synthesize text to audio via Mercury TTS service
 *   voice_extract - Parse voice transcription into structured order data
 */
@Injectable()
export class VoiceExecutor implements ActionExecutor {
  readonly name = 'voice';
  private readonly logger = new Logger(VoiceExecutor.name);
  private readonly ttsUrl: string;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.ttsUrl = this.configService.get('TTS_SERVICE_URL', 'http://localhost:7002');
  }

  async execute(
    config: Record<string, any>,
    context: FlowContext,
  ): Promise<ActionExecutionResult> {
    const action = config.action as string;

    switch (action) {
      case 'tts_respond':
        return this.ttsSynthesize(config, context);
      case 'voice_extract':
        return this.voiceExtract(config, context);
      default:
        return { success: false, error: `Unknown voice action: ${action}` };
    }
  }

  /**
   * tts_respond: Call Mercury TTS to synthesize text into audio.
   *
   * Config:
   *   text      - explicit text to synthesize
   *   language  - language code (default 'hi')
   *   voice     - voice name (default 'chotu' for Hindi)
   *
   * Falls back to context.data._last_response.message if no text provided.
   */
  private async ttsSynthesize(
    config: Record<string, any>,
    context: FlowContext,
  ): Promise<ActionExecutionResult> {
    const text =
      config.text ||
      context.data?._last_response?.message;

    if (!text) {
      return { success: false, error: 'No text available for TTS synthesis' };
    }

    const language = config.language || 'hi';
    const voice = config.voice || (language === 'hi' ? 'chotu' : 'af_bella');

    try {
      const response = await firstValueFrom(
        this.httpService.post(
          `${this.ttsUrl}/synthesize`,
          {
            text,
            language,
            voice,
            speed: config.speed || 1.0,
            emotion: 'neutral',
            style: language === 'hi' ? 'chotu_helpful' : 'default',
          },
          {
            responseType: 'arraybuffer',
            timeout: 30000,
          },
        ),
      );

      // Convert to base64 data URL so downstream messaging can attach audio
      const audioBuffer = Buffer.from(response.data);
      const audioBase64 = audioBuffer.toString('base64');
      const audioUrl = `data:audio/wav;base64,${audioBase64}`;

      this.logger.log(
        `TTS synthesized ${text.length} chars → ${audioBuffer.length} bytes (${language}/${voice})`,
      );

      return {
        success: true,
        output: { audioUrl, text, language, voice, audioSize: audioBuffer.length },
        event: 'tts_done',
      };
    } catch (error) {
      this.logger.error(`TTS synthesis failed: ${error.message}`);
      return {
        success: false,
        error: `TTS synthesis failed: ${error.message}`,
        event: 'tts_error',
      };
    }
  }

  /**
   * voice_extract: Parse a voice transcription into structured order fields
   * using fast regex/heuristic extraction (no LLM call).
   *
   * Config:
   *   text - transcription text (falls back to context.data.userMessage)
   *
   * Returns parsed fields: items[], storeName, payment, address keywords.
   */
  private async voiceExtract(
    config: Record<string, any>,
    context: FlowContext,
  ): Promise<ActionExecutionResult> {
    const text = config.text || context.data?.userMessage;

    if (!text) {
      return { success: false, error: 'No text available for voice extraction' };
    }

    const normalised = text.toLowerCase().trim();
    const parsed: Record<string, any> = {};

    // --- Extract items with quantities ---
    // Patterns: "2 biryani", "ek samosa", "teen chai", "1x pizza"
    const hindiNumbers: Record<string, number> = {
      ek: 1, do: 2, teen: 3, char: 4, panch: 5,
      chhe: 6, saat: 7, aath: 8, nau: 9, das: 10,
      // Common alternate spellings
      paanch: 5, chhah: 6, chah: 6,
    };

    const items: Array<{ name: string; quantity: number }> = [];

    // Match digit + item: "2 biryani", "1x pizza"
    const digitPattern = /(\d+)\s*x?\s+([a-zA-Z\u0900-\u097F]+(?:\s+[a-zA-Z\u0900-\u097F]+)?)/g;
    let m: RegExpExecArray | null;
    while ((m = digitPattern.exec(normalised)) !== null) {
      items.push({ name: m[2].trim(), quantity: parseInt(m[1], 10) });
    }

    // Match Hindi number + item: "ek samosa", "do chai"
    const hindiPattern = new RegExp(
      `(${Object.keys(hindiNumbers).join('|')})\\s+([a-zA-Z\\u0900-\\u097F]+(?:\\s+[a-zA-Z\\u0900-\\u097F]+)?)`,
      'g',
    );
    while ((m = hindiPattern.exec(normalised)) !== null) {
      items.push({ name: m[2].trim(), quantity: hindiNumbers[m[1]] });
    }

    // If no quantity found but a bare word exists, treat entire text minus known keywords as item
    if (items.length === 0) {
      const stripped = normalised
        .replace(/\b(from|se|ka|ki|ke|cash|cod|online|upi|home|office|ghar|deliver|bhej|do|dedo|mangwa|order)\b/g, '')
        .trim();
      if (stripped) {
        items.push({ name: stripped, quantity: 1 });
      }
    }

    if (items.length > 0) {
      parsed.items = items;
    }

    // --- Extract store name ---
    // "from inayat", "inayat se", "inayat cafe se"
    const storeMatch =
      normalised.match(/(?:from|)\s+([a-zA-Z\u0900-\u097F]+(?:\s+[a-zA-Z\u0900-\u097F]+)?)\s+(?:se|cafe|restaurant|hotel)/i) ||
      normalised.match(/from\s+([a-zA-Z\u0900-\u097F]+(?:\s+[a-zA-Z\u0900-\u097F]+)?)/i) ||
      normalised.match(/([a-zA-Z\u0900-\u097F]+)\s+se\b/i);

    if (storeMatch) {
      parsed.storeName = storeMatch[1].trim();
    }

    // --- Extract payment method ---
    if (/\b(cash|cod|cash\s*on\s*delivery|kash)\b/i.test(normalised)) {
      parsed.payment = 'cash_on_delivery';
    } else if (/\b(online|upi|card|gpay|google\s*pay|phonepe|paytm)\b/i.test(normalised)) {
      parsed.payment = 'online';
    }

    // --- Extract delivery target ---
    if (/\b(home|ghar|makan)\b/i.test(normalised)) {
      parsed.deliveryTarget = 'home';
    } else if (/\b(office|daftar|kaam)\b/i.test(normalised)) {
      parsed.deliveryTarget = 'office';
    }

    this.logger.log(
      `Voice extract: "${text}" → ${JSON.stringify(parsed)}`,
    );

    return {
      success: true,
      output: parsed,
      event: items.length > 0 ? 'extracted' : 'no_items',
    };
  }

  validate(config: Record<string, any>): boolean {
    return !!config.action && ['tts_respond', 'voice_extract'].includes(config.action);
  }
}
