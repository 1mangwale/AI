import {
  Controller,
  Get,
  Post,
  Body,
  Res,
  Logger,
  HttpException,
  HttpStatus,
  UseInterceptors,
  UploadedFile,
  Optional,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { Response } from 'express';
import FormData = require('form-data');
import { VoiceService } from '../../voice/services/voice.service';

/**
 * Voice Controller
 *
 * Proxies voice requests (ASR transcription, TTS synthesis)
 * and Mercury status to the frontend admin dashboard
 */
@Controller('voice')
export class VoiceController {
  private readonly logger = new Logger(VoiceController.name);
  private readonly asrUrl: string;
  private readonly ttsUrl: string;
  private readonly orchestratorUrl: string;
  private readonly nerveUrl: string;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    @Optional() private readonly voiceService?: VoiceService,
  ) {
    this.asrUrl = this.configService.get('ASR_SERVICE_URL', 'http://100.117.131.56:7001');
    this.ttsUrl = this.configService.get('TTS_SERVICE_URL', 'http://100.117.131.56:7002');
    this.orchestratorUrl = this.configService.get('VOICE_ORCHESTRATOR_URL', 'http://100.117.131.56:7000');
    this.nerveUrl = this.configService.get('NERVE_SERVICE_URL', 'http://100.117.131.56:7003');
    this.logger.log(`Voice Controller initialized - ASR: ${this.asrUrl}, TTS: ${this.ttsUrl}`);
  }

  // ============== MERCURY STATUS ==============

  /**
   * GET /voice/mercury/status
   * Returns health status of all Mercury voice services
   */
  @Get('mercury/status')
  async getMercuryStatus() {
    const results: any = {
      success: true,
      mercury: {
        asr: { status: 'offline', latency: 0 },
        tts: { status: 'offline', latency: 0 },
        orchestrator: { status: 'offline', latency: 0 },
        nerve: { status: 'offline', latency: 0, activeCalls: 0, ttsCacheSize: 0 },
      },
      gpus: [],
    };

    // Check ASR
    try {
      const start = Date.now();
      const res = await firstValueFrom(
        this.httpService.get(`${this.asrUrl}/health`, { timeout: 3000 }),
      );
      results.mercury.asr = {
        status: 'healthy',
        latency: Date.now() - start,
        gpu: res.data?.gpu_name || res.data?.gpu || null,
        providers: res.data?.providers || {},
      };
    } catch {
      results.mercury.asr.status = 'offline';
    }

    // Check TTS
    try {
      const start = Date.now();
      const res = await firstValueFrom(
        this.httpService.get(`${this.ttsUrl}/health`, { timeout: 3000 }),
      );
      results.mercury.tts = {
        status: 'healthy',
        latency: Date.now() - start,
        voices: res.data?.voices || {},
        gpu: res.data?.gpu_name || res.data?.gpu || null,
        providers: res.data?.providers || {},
      };
    } catch {
      results.mercury.tts.status = 'offline';
    }

    // Check Orchestrator
    try {
      const start = Date.now();
      await firstValueFrom(
        this.httpService.get(`${this.orchestratorUrl}/health`, { timeout: 3000 }),
      );
      results.mercury.orchestrator = {
        status: 'healthy',
        latency: Date.now() - start,
      };
    } catch {
      results.mercury.orchestrator.status = 'offline';
    }

    // Check Nerve
    try {
      const start = Date.now();
      const res = await firstValueFrom(
        this.httpService.get(`${this.nerveUrl}/health`, { timeout: 3000 }),
      );
      results.mercury.nerve = {
        status: 'healthy',
        latency: Date.now() - start,
        activeCalls: res.data?.activeCalls || 0,
        ttsCacheSize: res.data?.ttsCacheSize || 0,
      };
    } catch {
      results.mercury.nerve.status = 'offline';
    }

    // Fetch GPU info from both machines
    results.gpus = await this.getGpuInfo();

    return results;
  }

  /**
   * Get GPU info from both Jupiter (local) and Mercury (100.117.131.56)
   */
  private async getGpuInfo(): Promise<any[]> {
    const gpus: any[] = [];
    const { execSync } = require('child_process');

    // Jupiter (local) GPU — vLLM
    try {
      const raw = execSync(
        'nvidia-smi --query-gpu=name,memory.total,memory.used,memory.free,utilization.gpu,temperature.gpu --format=csv,noheader,nounits',
        { timeout: 3000 },
      ).toString().trim();
      const parts = raw.split(',').map((s: string) => s.trim());
      gpus.push({
        host: 'Jupiter (local)',
        name: parts[0],
        memoryTotal: `${parts[1]} MiB`,
        memoryUsed: `${parts[2]} MiB`,
        memoryFree: `${parts[3]} MiB`,
        utilization: `${parts[4]}%`,
        temperature: `${parts[5]}°C`,
        services: ['vLLM (Qwen2.5-7B)'],
      });
    } catch (e) {
      this.logger.warn(`Failed to get local GPU info: ${e.message}`);
    }

    // Mercury (100.117.131.56) GPU — NLU, NER, ASR, TTS
    try {
      const raw = execSync(
        'ssh -o ConnectTimeout=3 -o StrictHostKeyChecking=no ubuntu@100.117.131.56 "nvidia-smi --query-gpu=name,memory.total,memory.used,memory.free,utilization.gpu,temperature.gpu --format=csv,noheader,nounits"',
        { timeout: 5000 },
      ).toString().trim();
      const parts = raw.split(',').map((s: string) => s.trim());
      gpus.push({
        host: 'Mercury (100.117.131.56)',
        name: parts[0],
        memoryTotal: `${parts[1]} MiB`,
        memoryUsed: `${parts[2]} MiB`,
        memoryFree: `${parts[3]} MiB`,
        utilization: `${parts[4]}%`,
        temperature: `${parts[5]}°C`,
        services: ['NLU (IndicBERTv2)', 'NER (MuRIL)', 'ASR (Whisper)', 'TTS (Chatterbox+Kokoro)'],
      });
    } catch (e) {
      this.logger.warn(`Failed to get Mercury GPU info: ${e.message}`);
    }

    return gpus;
  }

  /**
   * GET /voice/mercury/voices
   * Returns available TTS voices from Mercury TTS service
   */
  @Get('mercury/voices')
  async getMercuryVoices() {
    try {
      const res = await firstValueFrom(
        this.httpService.get(`${this.ttsUrl}/voices`, { timeout: 5000 }),
      );
      return { success: true, ...res.data };
    } catch (error) {
      this.logger.warn(`Failed to fetch voices from TTS: ${error.message}`);
      // Return known voice configuration as fallback
      return {
        success: false,
        kokoro: {
          voices: ['af_heart', 'af_bella', 'am_adam', 'am_michael'],
          languages: ['en-us', 'en-gb', 'hi'],
          description: 'Kokoro TTS - Fast, lightweight',
        },
        chatterbox: {
          voices: ['chotu', 'default'],
          languages: ['en', 'hi'],
          emotions: ['helpful', 'happy', 'calm', 'excited'],
          styles: ['conversational', 'formal', 'friendly'],
          description: 'Chatterbox TTS - Expressive, emotional',
        },
      };
    }
  }

  /**
   * POST /voice/mercury/tts
   * Generate speech from text via Mercury TTS
   */
  @Post('mercury/tts')
  async generateTts(
    @Body() body: {
      text: string;
      voice?: string;
      language?: string;
      emotion?: string;
      style?: string;
      speed?: number;
      provider?: string;
      exaggeration?: number;
      cfg_weight?: number;
      pitch?: number;
    },
  ) {
    const { text, voice = 'chotu', language = 'hi', provider = 'chatterbox', ...params } = body;

    if (!text || text.trim().length === 0) {
      throw new HttpException('No text provided', HttpStatus.BAD_REQUEST);
    }

    try {
      const start = Date.now();
      const response = await firstValueFrom(
        this.httpService.post(
          `${this.ttsUrl}/synthesize`,
          { text, voice, language, provider, ...params },
          { responseType: 'arraybuffer', timeout: 20000 },
        ),
      );

      const latency = Date.now() - start;
      this.logger.log(`TTS synthesis: ${response.data.byteLength} bytes in ${latency}ms`);

      return {
        success: true,
        audio: Buffer.from(response.data).toString('base64'),
        contentType: response.headers['content-type'] || 'audio/wav',
        latency,
      };
    } catch (error) {
      this.logger.error(`TTS synthesis error: ${error.message}`);
      return { success: false, error: error.message || 'TTS synthesis failed', audio: null };
    }
  }

  // ============== ASR PROXY ==============

  /**
   * POST /voice/transcribe
   * Transcribe audio file to text
   */
  @Post('transcribe')
  @UseInterceptors(FileInterceptor('audio'))
  async transcribe(
    @UploadedFile() audioFile: Express.Multer.File,
    @Body() body: { language?: string },
  ) {
    try {
      if (!audioFile) {
        throw new HttpException('No audio file provided', HttpStatus.BAD_REQUEST);
      }

      const formData = new FormData();
      formData.append('audio', audioFile.buffer, {
        filename: audioFile.originalname || 'audio.webm',
        contentType: audioFile.mimetype || 'audio/webm',
      });
      if (body.language) {
        formData.append('language', body.language);
      }

      const start = Date.now();
      const response = await firstValueFrom(
        this.httpService.post(`${this.asrUrl}/transcribe`, formData, {
          headers: formData.getHeaders(),
          timeout: 15000,
        }),
      );

      return {
        success: true,
        text: response.data.text,
        language: response.data.language || 'en-US',
        confidence: response.data.confidence || 0.95,
        latency: Date.now() - start,
      };
    } catch (error) {
      this.logger.error(`Transcription error: ${error.message}`);
      return { success: false, error: error.message || 'Transcription failed', text: '' };
    }
  }

  /**
   * POST /voice/synthesize (legacy endpoint for chat frontend)
   */
  @Post('synthesize')
  async synthesize(
    @Body() body: { text: string; language?: string; voice?: string },
  ) {
    const { text, language = 'en-US', voice } = body;

    try {
      if (!text || text.trim().length === 0) {
        throw new HttpException('No text provided', HttpStatus.BAD_REQUEST);
      }

      const response = await firstValueFrom(
        this.httpService.post(
          `${this.ttsUrl}/synthesize`,
          { text, language, voice },
          { responseType: 'arraybuffer', timeout: 20000 },
        ),
      );

      return {
        success: true,
        audio: Buffer.from(response.data).toString('base64'),
        contentType: response.headers['content-type'] || 'audio/wav',
      };
    } catch (error) {
      this.logger.error(`TTS synthesis error: ${error.message}`);
      return { success: false, error: error.message || 'TTS synthesis failed', audio: null };
    }
  }

  /**
   * GET /voice/health
   */
  @Get('health')
  async health() {
    const checks: any = { asr: false, tts: false };

    try {
      await firstValueFrom(this.httpService.get(`${this.asrUrl}/health`, { timeout: 3000 }));
      checks.asr = true;
    } catch {}

    try {
      await firstValueFrom(this.httpService.get(`${this.ttsUrl}/health`, { timeout: 3000 }));
      checks.tts = true;
    } catch {}

    return {
      success: checks.asr || checks.tts,
      status: checks.asr && checks.tts ? 'healthy' : 'degraded',
      services: checks,
      timestamp: new Date().toISOString(),
    };
  }

  // ============== VOICE NLU PIPELINE ==============

  /**
   * POST /voice/process
   * Process voice text through the same NLU/flow pipeline as chat.
   * Used by the web frontend's voice mode.
   */
  @Post('process')
  async processVoiceText(
    @Body() body: { phoneNumber: string; text: string },
  ) {
    if (!this.voiceService) {
      return { success: false, error: 'VoiceService not available' };
    }
    if (!body.phoneNumber || !body.text) {
      return { success: false, error: 'phoneNumber and text are required' };
    }

    const response = await this.voiceService.processVoiceInput(body.phoneNumber, body.text);
    return {
      success: true,
      message: response.message,
      buttons: response.buttons || [],
      routedTo: response.routedTo,
    };
  }

  /**
   * POST /webhook/voice/process
   * Twilio/Exotel webhook — receives transcribed speech, returns TwiML.
   * Multi-turn: always includes <Gather> for next speech input.
   */
  @Post('webhook/process')
  async processVoiceWebhook(
    @Body() body: any,
    @Res() res: Response,
  ) {
    if (!this.voiceService) {
      res.type('text/xml').send(
        '<?xml version="1.0" encoding="UTF-8"?><Response><Say>Voice service unavailable.</Say><Hangup/></Response>',
      );
      return;
    }

    // Extract speech from Twilio/Exotel webhook body
    const speechText = body.SpeechResult || body.speech_result || body.transcript || '';
    const phoneNumber = body.From || body.from || body.caller_id || '';

    if (!speechText) {
      const welcome = this.voiceService.generateWelcome();
      res.type('text/xml').send(welcome.xml);
      return;
    }

    this.logger.log(`📞 Webhook voice input from ${phoneNumber}: "${speechText.substring(0, 50)}..."`);

    try {
      const response = await this.voiceService.processVoiceInput(phoneNumber, speechText);
      // Strip markdown formatting for voice (bold, bullets, etc.)
      const cleanText = (response.message || '')
        .replace(/\*\*/g, '')
        .replace(/[*_~`#]/g, '')
        .replace(/\n+/g, '. ');

      const twiml = this.voiceService.generateSpeechResponse(cleanText, true);
      res.type('text/xml').send(twiml.xml);
    } catch (error: any) {
      this.logger.error(`Voice webhook processing failed: ${error.message}`);
      const errorTwiml = this.voiceService.generateError();
      res.type('text/xml').send(errorTwiml.xml);
    }
  }
}
