import { Controller, Get, Post, Put, Delete, Body, Param, Query, HttpException, HttpStatus, Logger, UseGuards } from '@nestjs/common';
import { SecretsService } from './secrets.service';
import { AdminAuthGuard } from '../admin/guards/admin-auth.guard';

interface CreateSecretDto {
  name: string;
  value: string;
  description?: string;
  category?: string;
  expiresAt?: string; // ISO date string
}

interface UpdateSecretDto {
  value?: string;
  description?: string;
  expiresAt?: string; // ISO date string
}

/**
 * Secrets Controller - Admin API for managing API keys and secrets
 * 
 * All secret values are stored encrypted in the database.
 * Values are never returned in full - only masked versions for display.
 *
 * Guarded at the class level. This module is not currently imported into
 * AppModule, so every route here 404s today -- which is exactly why the guard
 * belongs on it now: whoever mounts it next inherits a closed controller
 * instead of an open secret store.
 */
@Controller('secrets')
@UseGuards(AdminAuthGuard)
export class SecretsController {
  private readonly logger = new Logger(SecretsController.name);

  constructor(private readonly secretsService: SecretsService) {}

  /**
   * List all secrets (without actual values)
   */
  @Get()
  async listSecrets() {
    try {
      const secrets = await this.secretsService.listSecrets();
      return {
        success: true,
        secrets: secrets.map(s => ({
          ...s,
          lastRotated: s.lastRotated?.toISOString() || null,
          expiresAt: s.expiresAt?.toISOString() || null,
        })),
      };
    } catch (error) {
      this.logger.error(`Failed to list secrets: ${error.message}`);
      throw new HttpException('Failed to list secrets', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  /**
   * Get expiring secrets (alerts)
   */
  @Get('alerts/expiring')
  async getExpiringSecrets(@Query('days') days?: string) {
    try {
      const withinDays = parseInt(days || '30', 10);
      const expiring = await this.secretsService.getExpiringSecrets(withinDays);
      const expired = await this.secretsService.getExpiredSecrets();

      return {
        success: true,
        expiring: expiring.map(s => ({
          ...s,
          expiresAt: s.expiresAt.toISOString(),
        })),
        expired: expired.map(s => ({
          ...s,
          expiresAt: s.expiresAt.toISOString(),
        })),
        totalAlerts: expiring.length + expired.length,
      };
    } catch (error) {
      this.logger.error(`Failed to get expiring secrets: ${error.message}`);
      throw new HttpException('Failed to get expiring secrets', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  /**
   * Get a secret's metadata and masked value
   */
  @Get(':name')
  async getSecret(@Param('name') name: string) {
    try {
      const value = await this.secretsService.getSecret(name);
      
      if (!value) {
        throw new HttpException('Secret not found', HttpStatus.NOT_FOUND);
      }

      // Mask the value (show first 4 and last 4 chars)
      const maskedValue = this.maskValue(value);

      // Get metadata by listing and filtering
      const allSecrets = await this.secretsService.listSecrets();
      const metadata = allSecrets.find(s => s.name === name);

      return {
        success: true,
        secret: {
          name,
          maskedValue,
          category: metadata?.category || 'api_key',
          description: metadata?.description || null,
          lastRotated: metadata?.lastRotated?.toISOString() || null,
        },
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error(`Failed to get secret '${name}': ${error.message}`);
      throw new HttpException('Failed to get secret', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  /**
   * Create or update a secret
   */
  @Post()
  async createSecret(@Body() dto: CreateSecretDto) {
    try {
      if (!dto.name || !dto.value) {
        throw new HttpException('Name and value are required', HttpStatus.BAD_REQUEST);
      }

      // Validate name format (lowercase, underscores, alphanumeric)
      if (!/^[a-z0-9_]+$/.test(dto.name)) {
        throw new HttpException('Invalid name format. Use lowercase letters, numbers, and underscores only.', HttpStatus.BAD_REQUEST);
      }

      // Parse expiration date if provided
      let expiresAt: Date | undefined;
      if (dto.expiresAt) {
        expiresAt = new Date(dto.expiresAt);
        if (isNaN(expiresAt.getTime())) {
          throw new HttpException('Invalid expiration date format', HttpStatus.BAD_REQUEST);
        }
      }

      await this.secretsService.setSecret(
        dto.name,
        dto.value,
        dto.description,
        dto.category || 'api_key',
        expiresAt,
      );

      this.logger.log(`Secret '${dto.name}' created/updated`);

      return {
        success: true,
        message: `Secret '${dto.name}' saved successfully`,
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error(`Failed to create secret: ${error.message}`);
      throw new HttpException('Failed to create secret', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  /**
   * Update an existing secret
   */
  @Put(':name')
  async updateSecret(@Param('name') name: string, @Body() dto: UpdateSecretDto) {
    try {
      // Check if secret exists
      const existing = await this.secretsService.getSecret(name);
      if (!existing) {
        throw new HttpException('Secret not found', HttpStatus.NOT_FOUND);
      }

      // If value is provided, update it
      if (dto.value) {
        await this.secretsService.setSecret(name, dto.value, dto.description);
      }

      this.logger.log(`Secret '${name}' updated`);

      return {
        success: true,
        message: `Secret '${name}' updated successfully`,
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error(`Failed to update secret '${name}': ${error.message}`);
      throw new HttpException('Failed to update secret', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  /**
   * Delete (deactivate) a secret
   */
  @Delete(':name')
  async deleteSecret(@Param('name') name: string) {
    try {
      // Check if secret exists
      const existing = await this.secretsService.getSecret(name);
      if (!existing) {
        throw new HttpException('Secret not found', HttpStatus.NOT_FOUND);
      }

      await this.secretsService.deleteSecret(name);

      this.logger.log(`Secret '${name}' deleted`);

      return {
        success: true,
        message: `Secret '${name}' deleted successfully`,
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error(`Failed to delete secret '${name}': ${error.message}`);
      throw new HttpException('Failed to delete secret', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  /**
   * Rotate a secret (update with new value)
   */
  @Post(':name/rotate')
  async rotateSecret(@Param('name') name: string, @Body() body: { value: string }) {
    try {
      if (!body.value) {
        throw new HttpException('New value is required for rotation', HttpStatus.BAD_REQUEST);
      }

      // Check if secret exists
      const existing = await this.secretsService.getSecret(name);
      if (!existing) {
        throw new HttpException('Secret not found', HttpStatus.NOT_FOUND);
      }

      // Get metadata
      const allSecrets = await this.secretsService.listSecrets();
      const metadata = allSecrets.find(s => s.name === name);

      // Update with new value (this also updates lastRotated)
      await this.secretsService.setSecret(
        name,
        body.value,
        metadata?.description,
        metadata?.category || 'api_key',
      );

      this.logger.log(`Secret '${name}' rotated`);

      return {
        success: true,
        message: `Secret '${name}' rotated successfully`,
        lastRotated: new Date().toISOString(),
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error(`Failed to rotate secret '${name}': ${error.message}`);
      throw new HttpException('Failed to rotate secret', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  /**
   * Mask a secret value for display
   */
  private maskValue(value: string): string {
    if (value.length <= 8) {
      return '●'.repeat(value.length);
    }
    return value.substring(0, 4) + '●'.repeat(value.length - 8) + value.substring(value.length - 4);
  }
}
