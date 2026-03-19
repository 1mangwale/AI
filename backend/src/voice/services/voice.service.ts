import { Injectable, Logger, Optional, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { ContextRouterService, RouterResponse } from '../../messaging/services/context-router.service';
import { SessionService } from '../../session/session.service';

/**
 * 📞 Voice IVR Service
 * 
 * Handles voice call interactions:
 * - Speech-to-Text (ASR via Whisper)
 * - AI Processing (FlowEngine)
 * - Text-to-Speech (TTS via XTTS)
 * 
 * Providers:
 * - Twilio (Global) - programmable voice
 * - Exotel (India) - cloud telephony
 * 
 * Flow:
 * 1. User calls IVR number
 * 2. Play welcome message
 * 3. Record speech input
 * 4. Transcribe via ASR
 * 5. Process through AI
 * 6. Synthesize response via TTS
 * 7. Play back to user
 */

export interface VoiceSession {
  callSid: string;
  from: string;
  to: string;
  status: 'initiated' | 'ringing' | 'in-progress' | 'completed' | 'busy' | 'failed';
  startTime: Date;
  language: string;
}

export interface TwiMLResponse {
  xml: string;
}

@Injectable()
export class VoiceService {
  private readonly logger = new Logger(VoiceService.name);
  
  // Twilio config
  private readonly twilioAccountSid: string;
  private readonly twilioAuthToken: string;
  private readonly twilioPhoneNumber: string;
  
  // Exotel config (India)
  private readonly exotelSid: string;
  private readonly exotelToken: string;
  private readonly exotelPhone: string;
  
  // ASR/TTS URLs
  private readonly asrUrl: string;
  private readonly ttsUrl: string;
  private readonly baseUrl: string;
  
  private enabled = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
    @Optional() @Inject(forwardRef(() => ContextRouterService))
    private readonly contextRouter?: ContextRouterService,
    @Optional() private readonly sessionService?: SessionService,
  ) {
    // Twilio
    this.twilioAccountSid = this.configService.get('TWILIO_ACCOUNT_SID', '');
    this.twilioAuthToken = this.configService.get('TWILIO_AUTH_TOKEN', '');
    this.twilioPhoneNumber = this.configService.get('TWILIO_PHONE_NUMBER', '');
    
    // Exotel
    this.exotelSid = this.configService.get('EXOTEL_SID', '');
    this.exotelToken = this.configService.get('EXOTEL_TOKEN', '');
    this.exotelPhone = this.configService.get('EXOTEL_PHONE', '');
    
    // Mercury server services (ASR: 7001, TTS: 7002)
    this.asrUrl = this.configService.get('ASR_SERVICE_URL');
    this.ttsUrl = this.configService.get('TTS_SERVICE_URL');
    this.baseUrl = this.configService.get('BASE_URL');
    
    this.enabled = !!(this.twilioAuthToken || this.exotelToken);
    
    if (this.enabled) {
      this.logger.log('✅ VoiceService initialized');
    } else {
      this.logger.warn('⚠️ VoiceService disabled (no credentials configured)');
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Generate TwiML welcome message
   */
  generateWelcome(language: string = 'en-IN'): TwiMLResponse {
    const welcomeAudioUrl = `${this.baseUrl}/voice/audio/welcome.mp3`;
    
    return {
      xml: `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice" language="${language}">
    Welcome to Mangwale. How can I help you today?
  </Say>
  <Gather input="speech" action="${this.baseUrl}/webhook/voice/process" 
         language="${language}" speechTimeout="3" timeout="10">
    <Say voice="alice" language="${language}">Please speak after the beep.</Say>
  </Gather>
  <Say voice="alice" language="${language}">
    I didn't hear anything. Please call back if you need assistance. Goodbye.
  </Say>
</Response>`,
    };
  }

  /**
   * Generate TwiML response with synthesized speech
   */
  generateSpeechResponse(
    text: string,
    continueGathering: boolean = true,
    language: string = 'en-IN',
  ): TwiMLResponse {
    const gatherXml = continueGathering
      ? `<Gather input="speech" action="${this.baseUrl}/webhook/voice/process" 
               language="${language}" speechTimeout="3" timeout="10">
           <Say voice="alice" language="${language}">${this.escapeXml(text)}</Say>
         </Gather>`
      : `<Say voice="alice" language="${language}">${this.escapeXml(text)}</Say>`;

    return {
      xml: `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${gatherXml}
  <Say voice="alice" language="${language}">
    Is there anything else I can help you with?
  </Say>
  <Gather input="speech" action="${this.baseUrl}/webhook/voice/process" 
         language="${language}" speechTimeout="3" timeout="10">
  </Gather>
  <Say voice="alice" language="${language}">Thank you for calling Mangwale. Goodbye.</Say>
</Response>`,
    };
  }

  /**
   * Generate TwiML with custom audio (from TTS)
   */
  generateAudioResponse(
    audioUrl: string,
    continueGathering: boolean = true,
    language: string = 'en-IN',
  ): TwiMLResponse {
    const gatherXml = continueGathering
      ? `<Gather input="speech" action="${this.baseUrl}/webhook/voice/process" 
               language="${language}" speechTimeout="3" timeout="10">
           <Play>${audioUrl}</Play>
         </Gather>`
      : `<Play>${audioUrl}</Play>`;

    return {
      xml: `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${gatherXml}
</Response>`,
    };
  }

  /**
   * Generate goodbye TwiML
   */
  generateGoodbye(language: string = 'en-IN'): TwiMLResponse {
    return {
      xml: `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice" language="${language}">
    Thank you for calling Mangwale. Have a great day. Goodbye.
  </Say>
  <Hangup/>
</Response>`,
    };
  }

  /**
   * Generate error TwiML
   */
  generateError(language: string = 'en-IN'): TwiMLResponse {
    return {
      xml: `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice" language="${language}">
    Sorry, we are experiencing technical difficulties. Please try again later.
  </Say>
  <Hangup/>
</Response>`,
    };
  }

  /**
   * Generate DTMF menu TwiML
   */
  generateDtmfMenu(
    prompt: string,
    options: Array<{ digit: string; label: string }>,
    language: string = 'en-IN',
  ): TwiMLResponse {
    const optionsText = options
      .map(o => `Press ${o.digit} for ${o.label}`)
      .join('. ');

    return {
      xml: `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="dtmf" action="${this.baseUrl}/webhook/voice/dtmf" 
          numDigits="1" timeout="10">
    <Say voice="alice" language="${language}">${this.escapeXml(prompt)}</Say>
    <Say voice="alice" language="${language}">${this.escapeXml(optionsText)}</Say>
  </Gather>
  <Say voice="alice" language="${language}">
    We didn't receive your selection. Please try again.
  </Say>
  <Redirect>${this.baseUrl}/webhook/voice</Redirect>
</Response>`,
    };
  }

  /**
   * Transcribe audio using ASR service
   */
  async transcribeAudio(
    audioUrl: string,
    language: string = 'hi',
  ): Promise<{ text: string; confidence: number } | null> {
    try {
      const response = await firstValueFrom(
        this.httpService.post(`${this.asrUrl}/transcribe`, {
          audio_url: audioUrl,
          language,
        }),
      );

      return {
        text: response.data.text || response.data.transcription,
        confidence: response.data.confidence || 0.9,
      };
    } catch (error: any) {
      this.logger.error(`ASR transcription failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Synthesize speech using TTS service
   */
  async synthesizeSpeech(
    text: string,
    language: string = 'hi',
    voice: string = 'female_1',
  ): Promise<string | null> {
    try {
      const response = await firstValueFrom(
        this.httpService.post(
          `${this.ttsUrl}/synthesize`,
          {
            text,
            language,
            voice,
          },
          { responseType: 'arraybuffer' },
        ),
      );

      // Return base64 audio or URL depending on TTS service response
      if (response.data.audio_url) {
        return response.data.audio_url;
      }

      // For streaming TTS, might return audio directly
      // Would need to upload to accessible URL
      return null;
    } catch (error: any) {
      this.logger.error(`TTS synthesis failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Parse Twilio webhook body
   */
  parseTwilioWebhook(body: any): {
    callSid: string;
    from: string;
    to: string;
    speechResult?: string;
    digits?: string;
    recordingUrl?: string;
    callStatus?: string;
  } | null {
    if (!body.CallSid) return null;

    return {
      callSid: body.CallSid,
      from: body.From,
      to: body.To,
      speechResult: body.SpeechResult,
      digits: body.Digits,
      recordingUrl: body.RecordingUrl,
      callStatus: body.CallStatus,
    };
  }

  /**
   * Parse Exotel webhook body
   */
  parseExotelWebhook(body: any): {
    callSid: string;
    from: string;
    to: string;
    digits?: string;
    recordingUrl?: string;
    status?: string;
  } | null {
    if (!body.CallSid && !body.sid) return null;

    return {
      callSid: body.CallSid || body.sid,
      from: body.From || body.from,
      to: body.To || body.to,
      digits: body.digits,
      recordingUrl: body.RecordingUrl || body.recording_url,
      status: body.Status || body.status,
    };
  }

  /**
   * Detect language from phone number (for India)
   */
  detectLanguageFromPhone(phoneNumber: string): string {
    // Indian phone numbers
    if (phoneNumber.startsWith('+91') || phoneNumber.startsWith('91')) {
      // Default to Hindi for Indian numbers
      // Could map to regional languages based on area code
      return 'hi-IN';
    }
    
    // Default to English
    return 'en-IN';
  }

  /**
   * Escape XML special characters
   */
  private escapeXml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /**
   * Make outbound call (Twilio)
   */
  async makeOutboundCall(
    to: string,
    message: string,
  ): Promise<{ success: boolean; callSid?: string; error?: string }> {
    if (!this.twilioAccountSid || !this.twilioAuthToken) {
      return { success: false, error: 'Twilio not configured' };
    }

    try {
      const url = `https://api.twilio.com/2010-04-01/Accounts/${this.twilioAccountSid}/Calls.json`;
      
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">${this.escapeXml(message)}</Say>
</Response>`;

      const params = new URLSearchParams();
      params.append('To', to);
      params.append('From', this.twilioPhoneNumber);
      params.append('Twiml', twiml);

      const response = await firstValueFrom(
        this.httpService.post(url, params.toString(), {
          auth: {
            username: this.twilioAccountSid,
            password: this.twilioAuthToken,
          },
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        }),
      );

      return { success: true, callSid: response.data.sid };
    } catch (error: any) {
      this.logger.error(`Outbound call failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Process voice input through the same NLU/flow pipeline as chat.
   * Links voice sessions with existing chat sessions by phone number.
   */
  async processVoiceInput(
    phoneNumber: string,
    speechText: string,
  ): Promise<RouterResponse> {
    if (!this.contextRouter || !this.sessionService) {
      this.logger.warn('Voice pipeline not wired: ContextRouter or SessionService unavailable');
      return { message: 'Voice processing is not available.', routedTo: 'direct' };
    }

    try {
      // Normalize phone number (remove +, ensure it's the session identifier format)
      const identifier = phoneNumber.replace(/^\+/, '');

      // Get or create session — reuses existing chat session for same phone
      let session = await this.sessionService.getSession(identifier);
      if (!session) {
        session = await this.sessionService.createSession(identifier);
      }

      this.logger.log(`📞 Voice input from ${identifier}: "${speechText.substring(0, 50)}..."`);

      // Route through the SAME pipeline as chat (NLU → flow → agent)
      const response = await this.contextRouter.routeSync({
        messageId: `voice_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        identifier,
        message: speechText,
        channel: 'voice',
        sessionId: identifier,
        timestamp: Date.now(),
        metadata: { source: 'voice_call', platform: 'voice' },
      });

      this.logger.log(`📞 Voice response: "${(response?.message || '').substring(0, 50)}..."`);
      return response || { message: 'I could not process that. Please try again.', routedTo: 'direct' };
    } catch (error: any) {
      this.logger.error(`Voice processing failed: ${error.message}`);
      return { message: 'Sorry, there was an error processing your request.', routedTo: 'direct' };
    }
  }
}
