import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ActionExecutor, ActionExecutionResult, FlowContext } from '../types/flow.types';
import { ZoneService } from '../../zones/services/zone.service';

/**
 * Zone Executor
 *
 * Validates if coordinates are in serviceable zone using the PHP backend's
 * point-in-polygon detection via ZoneService (dynamic, database-driven zones).
 */
@Injectable()
export class ZoneExecutor implements ActionExecutor {
  readonly name = 'zone';
  private readonly logger = new Logger(ZoneExecutor.name);

  private readonly fallbackZones: Array<{ name: string; zoneId: number; minLat: number; maxLat: number; minLng: number; maxLng: number }>;

  constructor(
    @Optional() @Inject(ZoneService) private readonly zoneService?: ZoneService,
    @Optional() private readonly configService?: ConfigService,
  ) {
    this.fallbackZones = this.configService?.get('geo.fallbackZones') || [
      { name: 'Nashik City', zoneId: 4, minLat: 19.9, maxLat: 20.1, minLng: 73.6, maxLng: 73.9 },
      { name: 'Pune City', zoneId: 5, minLat: 18.4, maxLat: 18.7, minLng: 73.7, maxLng: 74.0 },
      { name: 'Mumbai', zoneId: 6, minLat: 18.87, maxLat: 19.3, minLng: 72.7, maxLng: 73.1 },
    ];
  }

  async execute(
    config: Record<string, any>,
    context: FlowContext
  ): Promise<ActionExecutionResult> {
    try {
      // Support both direct values and paths to context data
      let latitude: number;
      let longitude: number;

      if (config.latPath && config.lngPath) {
        // Extract from context using path
        latitude = this.getValueByPath(context.data, config.latPath);
        longitude = this.getValueByPath(context.data, config.lngPath);

        // Fallback: try alternative field names (lat/latitude, lng/longitude)
        if (!latitude || !longitude) {
          const pathParts = config.latPath.split('.');
          const objPath = pathParts.slice(0, -1).join('.');
          const obj = objPath ? this.getValueByPath(context.data, objPath) : context.data;

          if (obj && typeof obj === 'object') {
            latitude = latitude || obj['latitude'] || obj['lat'];
            longitude = longitude || obj['longitude'] || obj['lng'] || obj['long'];
          }
        }
      } else {
        // Direct values
        latitude = config.latitude as number;
        longitude = config.longitude as number;
      }

      if (!latitude || !longitude) {
        this.logger.error(`Missing coordinates. Config: ${JSON.stringify(config)}, Data: ${JSON.stringify(context.data)}`);
        return {
          success: false,
          error: 'Latitude and longitude required',
        };
      }

      this.logger.debug(`Validating zone for: (${latitude}, ${longitude})`);

      // Use ZoneService for dynamic zone detection via PHP backend API
      if (this.zoneService) {
        try {
          const zoneResult = await this.zoneService.getZoneIdByCoordinates(latitude, longitude);

          if (zoneResult && zoneResult.zone_id) {
            const output: Record<string, any> = {
              valid: true,
              zoneName: zoneResult.zone_name || `Zone ${zoneResult.zone_id}`,
              zoneId: zoneResult.zone_id,
              is_serviceable: zoneResult.is_serviceable,
              available_modules: zoneResult.available_modules || [],
              payment_methods: zoneResult.payment_methods || {},
              delivery_rates: zoneResult.delivery_rates || {},
            };

            // Save zone_id to top-level context so {{zone_id}} resolves everywhere
            context.data.zone_id = zoneResult.zone_id;

            this.logger.debug(`Zone validation: VALID - ${output.zoneName} (ID: ${output.zoneId})`);

            // Check module availability in zone if moduleId is specified
            const moduleId = config.moduleId != null
              ? (typeof config.moduleId === 'string' && config.moduleId.includes('.')
                ? this.getValueByPath(context.data, config.moduleId)
                : config.moduleId)
              : null;

            if (moduleId != null && output.available_modules && output.available_modules.length > 0) {
              const moduleMap: Record<number, string> = { 3: 'parcel', 4: 'food', 5: 'ecommerce' };
              const moduleName = moduleMap[Number(moduleId)] || String(moduleId).toLowerCase();
              const available = output.available_modules.map((m: string) => m.toLowerCase());

              if (!available.includes(moduleName)) {
                this.logger.warn(`Module "${moduleName}" not available in zone "${output.zoneName}". Available: ${available.join(', ')}`);
                return {
                  success: false,
                  output: { ...output, moduleAvailable: false },
                  event: 'zone_invalid',
                  error: `Module "${moduleName}" is not available in zone "${output.zoneName}"`,
                };
              }

              output.moduleAvailable = true;
            }

            return {
              success: true,
              output,
              event: 'zone_valid',
            };
          } else {
            this.logger.debug(`Zone validation: INVALID - No zone found for (${latitude}, ${longitude})`);
            return {
              success: true,
              output: {
                valid: false,
                zoneName: 'Outside service area',
                zoneId: null,
              },
              event: 'zone_invalid',
            };
          }
        } catch (zoneError) {
          this.logger.warn(`ZoneService failed, falling back to bounding box check: ${zoneError.message}`);
          // Fall through to bounding box fallback below
        }
      }

      // Fallback: bounding box check (used if ZoneService is unavailable)
      const fallbackResult = this.boundingBoxFallback(latitude, longitude);
      return fallbackResult;
    } catch (error) {
      this.logger.error(`Zone validation failed: ${error.message}`, error.stack);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Bounding box fallback - only used when ZoneService/PHP API is unavailable.
   * These are approximate bounds; the PHP API uses precise polygon detection.
   */
  private boundingBoxFallback(latitude: number, longitude: number): ActionExecutionResult {
    this.logger.warn('Using bounding box fallback for zone detection (ZoneService unavailable)');

    const serviceBounds = this.fallbackZones;

    let matchedZone = null;
    for (const zone of serviceBounds) {
      if (
        latitude >= zone.minLat && latitude <= zone.maxLat &&
        longitude >= zone.minLng && longitude <= zone.maxLng
      ) {
        matchedZone = zone;
        break;
      }
    }

    const isValid = matchedZone !== null;
    return {
      success: true,
      output: {
        valid: isValid,
        zoneName: matchedZone?.name || 'Outside service area',
        zoneId: matchedZone?.zoneId || null,
      },
      event: isValid ? 'zone_valid' : 'zone_invalid',
    };
  }

  validate(config: Record<string, any>): boolean {
    return !!(
      (config.latitude && config.longitude) ||
      (config.latPath && config.lngPath)
    );
  }

  private getValueByPath(data: any, path: string): any {
    const keys = path.split('.');
    let value = data;
    for (const key of keys) {
      if (value && typeof value === 'object' && key in value) {
        value = value[key];
      } else {
        return undefined;
      }
    }
    return value;
  }
}
