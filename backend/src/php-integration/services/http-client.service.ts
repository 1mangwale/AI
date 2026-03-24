import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { AxiosRequestConfig } from 'axios';

@Injectable()
export class PhpHttpClientService {
  private readonly logger = new Logger(PhpHttpClientService.name);
  private readonly baseUrl: string;
  private readonly timeout: number;

  constructor(
    private configService: ConfigService,
    private httpService: HttpService,
  ) {
    this.baseUrl = this.configService.get('php.baseUrl');
    this.timeout = this.configService.get('php.timeout');
    this.logger.log(`✅ PHP HTTP Client initialized: ${this.baseUrl}`);
  }

  async get<T = any>(endpoint: string, headers?: any): Promise<T> {
    return this.withRetry(async () => {
      const config: AxiosRequestConfig = {
        timeout: this.timeout,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          ...headers,
        },
      };

      const url = `${this.baseUrl}${endpoint}`;
      this.logger.debug(`GET ${url}`);

      const response = await firstValueFrom(
        this.httpService.get(url, config),
      );

      return response.data;
    }, 'GET', endpoint);
  }

  async post<T = any>(endpoint: string, data: any, headers?: any): Promise<T> {
    try {
      const config: AxiosRequestConfig = {
        timeout: this.timeout,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          ...headers,
        },
      };

      const url = `${this.baseUrl}${endpoint}`;
      this.logger.debug(`POST ${url}`);

      const response = await firstValueFrom(
        this.httpService.post(url, data, config),
      );

      return response.data;
    } catch (error) {
      this.handleError('POST', endpoint, error);
    }
  }

  async put<T = any>(endpoint: string, data: any, headers?: any): Promise<T> {
    try {
      const config: AxiosRequestConfig = {
        timeout: this.timeout,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          ...headers,
        },
      };

      const url = `${this.baseUrl}${endpoint}`;
      this.logger.debug(`PUT ${url}`);

      const response = await firstValueFrom(
        this.httpService.put(url, data, config),
      );

      return response.data;
    } catch (error) {
      this.handleError('PUT', endpoint, error);
    }
  }

  async delete<T = any>(endpoint: string, headers?: any, data?: any): Promise<T> {
    try {
      const config: AxiosRequestConfig = {
        timeout: this.timeout,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          ...headers,
        },
        data: data, // DELETE can have a body
      };

      const url = `${this.baseUrl}${endpoint}`;
      this.logger.debug(`DELETE ${url}`);

      const response = await firstValueFrom(
        this.httpService.delete(url, config),
      );

      return response.data;
    } catch (error) {
      this.handleError('DELETE', endpoint, error);
    }
  }

  /**
   * Retry wrapper for 5xx errors (server-side failures).
   * Only retries GET and idempotent read operations by default.
   */
  private async withRetry<T>(fn: () => Promise<T>, method: string, endpoint: string, maxRetries = 1): Promise<T> {
    let lastError: any;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        const status = error.response?.status;
        // Only retry on 5xx (server error) or network timeout, not 4xx (client error)
        if (attempt < maxRetries && (status >= 500 || !status)) {
          const delay = 500 * (attempt + 1); // 500ms, 1000ms
          this.logger.warn(`⚠️ ${method} ${endpoint} failed (${status || 'timeout'}), retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
    this.handleError(method, endpoint, lastError);
  }

  private handleError(method: string, endpoint: string, error: any): never {
    const errorMessage = error.response?.data?.message || error.response?.data?.errors?.[0]?.message || error.message;
    const statusCode = error.response?.status || 500;

    this.logger.error(
      `❌ ${method} ${endpoint} failed (${statusCode}): ${errorMessage}`,
      error.response?.data,
    );

    throw new Error(`PHP API Error: ${errorMessage}`);
  }
}


