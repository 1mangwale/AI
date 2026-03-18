import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import * as https from 'https';
import { CircuitBreakerService } from '../../common/services/circuit-breaker.service';

/**
 * Base PHP API Service
 * Handles HTTP client configuration, circuit breaker protection, and retry logic.
 * All child services (PhpPaymentService, PhpOrderService, etc.) inherit this automatically.
 */
@Injectable()
export class PhpApiService {
  protected readonly logger: Logger;
  protected readonly httpClient: AxiosInstance;
  protected readonly baseUrl: string;

  private readonly timeoutMap: Record<string, number> = {
    payment: 45000,
    search: 8000,
    auth: 15000,
    default: 30000,
  };

  constructor(
    protected readonly configService: ConfigService,
    private readonly circuitBreaker: CircuitBreakerService,
  ) {
    this.logger = new Logger(PhpApiService.name);
    // Prefer central configuration (src/config/configuration.ts -> php.baseUrl/php.timeout)
    const cfgBaseUrl = this.configService.get<string>('php.baseUrl');
    const envFallback = process.env.PHP_BACKEND_URL; // legacy env support
    
    this.baseUrl = cfgBaseUrl || envFallback;

    if (!this.baseUrl) {
      throw new Error('PHP_BACKEND_URL is not defined in environment variables');
    }

    const timeout = this.configService.get<number>('php.timeout') || 30000;

    this.httpClient = axios.create({
      baseURL: this.baseUrl,
      timeout,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      httpsAgent: new https.Agent({
        // SSL verification enabled - use NODE_EXTRA_CA_CERTS env if custom CA needed
      })
    });

    // Add response interceptor for error handling
    this.httpClient.interceptors.response.use(
      (response) => response.data, // Extract data from axios response
      (error) => {
        // Extract user-friendly error message from PHP backend response
        const phpError = error.response?.data;
        this.logger.error(`API Error: ${error.message}`, phpError);
        
        // Handle 401 Unauthorized - auth token expired or invalid
        if (error.response?.status === 401) {
          const authError = new Error('Your session has expired. Please log in again to continue.');
          (authError as any).code = 'AUTH_TOKEN_EXPIRED';
          (authError as any).statusCode = 401;
          (authError as any).requiresReAuth = true;
          (authError as any).skipCircuitBreaker = true; // 401 is client auth issue, not server failure
          this.logger.warn(
            `⚠️ PHP API returned 401 - auth token expired or invalid. ` +
            `URL: ${error.config?.url || 'unknown'}, Method: ${error.config?.method || 'unknown'}`,
          );
          throw authError;
        }

        // PHP backend returns errors in this format:
        // { errors: [{ code: "zone", message: "Out of coverage area" }] }
        if (phpError?.errors && Array.isArray(phpError.errors) && phpError.errors.length > 0) {
          const userMessage = phpError.errors.map((e: any) => e.message).join(', ');
          const enhancedError = new Error(userMessage);
          (enhancedError as any).code = phpError.errors[0].code;
          (enhancedError as any).statusCode = error.response?.status;
          throw enhancedError;
        }

        // Also handle simple message format (e.g. { "message": "OTP does not match" })
        if (phpError?.message) {
          const enhancedError = new Error(phpError.message);
          (enhancedError as any).statusCode = error.response?.status;
          throw enhancedError;
        }
        
        // Fallback to original error
        throw error;
      },
    );
  }

  /**
   * Check connection to PHP backend
   */
  public async checkConnection(): Promise<{ connected: boolean; latency: number; error?: string }> {
    const start = Date.now();
    try {
      // Try a lightweight endpoint - assuming /api/v1/settings or similar exists, 
      // or just check root/health if available. 
      // Using a HEAD request to root or a known public endpoint is safest.
      // Since we don't know exact endpoints, we'll try a simple GET to the base URL
      // or a likely public endpoint.
      await this.httpClient.get('/'); 
      return { connected: true, latency: Date.now() - start };
    } catch (error) {
      // Even 404 means we connected to the server
      if (error.response) {
        return { connected: true, latency: Date.now() - start };
      }
      return { connected: false, latency: 0, error: error.message };
    }
  }

  /**
   * Get timeout for a URL based on the endpoint type.
   */
  private getTimeoutForUrl(url: string): number {
    if (url.includes('payment') || url.includes('razor')) return this.timeoutMap.payment;
    if (url.includes('search') || url.includes('menu')) return this.timeoutMap.search;
    if (url.includes('otp') || url.includes('login') || url.includes('auth')) return this.timeoutMap.auth;
    return this.timeoutMap.default;
  }

  /**
   * Make POST request (circuit-breaker protected, no retry — mutations aren't idempotent)
   */
  protected async post(url: string, data?: any, headers?: any): Promise<any> {
    this.logger.log(`📤 POST ${url} - Data: ${JSON.stringify(data)}`);
    const timeout = this.getTimeoutForUrl(url);
    const config: any = { timeout };
    if (headers) config.headers = headers;

    return this.circuitBreaker.execute('php-backend', async () => {
      const response = await this.httpClient.post(url, data, config);
      this.logger.log(`📥 Response from ${url}: ${JSON.stringify(response).substring(0, 200)}`);
      return response;
    });
  }

  /**
   * Make GET request (circuit-breaker protected, retries up to 2x with exponential backoff)
   */
  protected async get(url: string, params?: any, headers?: any): Promise<any> {
    const timeout = this.getTimeoutForUrl(url);
    const config: any = { params, timeout };
    if (headers) config.headers = headers;

    return this.circuitBreaker.execute('php-backend', async () => {
      return this.retryRequest(() => this.httpClient.get(url, config), 2);
    });
  }

  /**
   * Make authenticated request with token (circuit-breaker protected).
   * Read ops (GET/DELETE) retry once; write ops (POST/PUT) do not retry.
   */
  protected async authenticatedRequest(
    method: 'get' | 'post' | 'put' | 'delete',
    url: string,
    token: string,
    data?: any,
    customHeaders?: Record<string, string>,
  ): Promise<any> {
    const timeout = this.getTimeoutForUrl(url);
    const config: any = {
      method,
      url,
      timeout,
      headers: {
        Authorization: `Bearer ${token}`,
        'X-localization': 'en',
        ...customHeaders,
      },
    };

    if (method === 'get' || method === 'delete') {
      config.params = data;
    } else {
      config.data = data;
    }

    const isReadOp = method === 'get' || method === 'delete';

    return this.circuitBreaker.execute('php-backend', async () => {
      if (isReadOp) {
        return this.retryRequest(() => this.httpClient.request(config), 1);
      }
      return this.httpClient.request(config);
    });
  }

  /**
   * Retry a request with exponential backoff.
   * Does NOT retry 401 (auth expired) or 404 (not found).
   */
  private async retryRequest<T>(fn: () => Promise<T>, maxRetries: number): Promise<T> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        const status = error.response?.status ?? (error as any).statusCode;
        if (attempt === maxRetries || status === 401 || status === 404) {
          throw error;
        }
        const delay = Math.pow(2, attempt) * 500; // 500ms, 1s
        this.logger.warn(`PHP API retry ${attempt + 1}/${maxRetries} after ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
}
