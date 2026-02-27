import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../redis/redis.module';

/**
 * Performance Alerting Service
 * 
 * Monitors system health and sends alerts when thresholds are breached:
 * - Response time P95 > 5s → Degraded
 * - Response time P95 > 10s → Critical
 * - Intent accuracy < 70% → Warning
 * - Conversion rate drop > 20% → Warning
 * - LLM provider failures > 10% → Warning
 */

export interface Alert {
  id: string;
  type: 'info' | 'warning' | 'critical';
  component: string;
  message: string;
  metric?: string;
  value?: number;
  threshold?: number;
  timestamp: Date;
  acknowledged: boolean;
}

export interface AlertThresholds {
  responseTimeP95Warning: number;  // ms
  responseTimeP95Critical: number; // ms
  intentAccuracyWarning: number;   // percentage
  conversionDropWarning: number;   // percentage
  llmFailureRateWarning: number;   // percentage
}

@Injectable()
export class AlertingService {
  private readonly logger = new Logger(AlertingService.name);
  private readonly ALERTS_KEY = 'analytics:alerts';
  
  // Alert thresholds
  private readonly thresholds: AlertThresholds = {
    responseTimeP95Warning: 3000,   // 3s
    responseTimeP95Critical: 5000,  // 5s
    intentAccuracyWarning: 70,      // 70%
    conversionDropWarning: 20,      // 20% drop
    llmFailureRateWarning: 10,      // 10% failures
  };

  // In-memory alert state
  private activeAlerts: Map<string, Alert> = new Map();

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly configService: ConfigService,
  ) {
    this.logger.log('✅ AlertingService initialized with shared Redis');
  }

  /**
   * Check and create alert if threshold breached
   */
  async checkThreshold(
    component: string,
    metric: string,
    value: number,
    threshold: number,
    comparison: 'gt' | 'lt', // greater than or less than
    severity: 'warning' | 'critical',
  ): Promise<Alert | null> {
    const breached = comparison === 'gt' 
      ? value > threshold 
      : value < threshold;

    if (!breached) {
      // Clear any existing alert for this metric
      const alertKey = `${component}:${metric}`;
      if (this.activeAlerts.has(alertKey)) {
        this.activeAlerts.delete(alertKey);
        await this.redis.hdel(this.ALERTS_KEY, alertKey);
        this.logger.log(`✅ Alert cleared: ${alertKey}`);
      }
      return null;
    }

    const alertKey = `${component}:${metric}`;
    const existingAlert = this.activeAlerts.get(alertKey);
    
    // Don't spam alerts - only create if new or escalated
    if (existingAlert && existingAlert.type === severity) {
      return existingAlert;
    }

    const alert: Alert = {
      id: `alert-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      type: severity,
      component,
      metric,
      message: this.formatAlertMessage(component, metric, value, threshold, comparison),
      value,
      threshold,
      timestamp: new Date(),
      acknowledged: false,
    };

    this.activeAlerts.set(alertKey, alert);
    await this.redis.hset(this.ALERTS_KEY, alertKey, JSON.stringify(alert));
    
    // Log alert
    if (severity === 'critical') {
      this.logger.error(`🚨 CRITICAL ALERT: ${alert.message}`);
    } else {
      this.logger.warn(`⚠️ WARNING: ${alert.message}`);
    }

    return alert;
  }

  /**
   * Check response time thresholds
   */
  async checkResponseTime(p95Ms: number): Promise<Alert | null> {
    // Check critical first
    if (p95Ms > this.thresholds.responseTimeP95Critical) {
      return this.checkThreshold(
        'response_time',
        'p95',
        p95Ms,
        this.thresholds.responseTimeP95Critical,
        'gt',
        'critical',
      );
    }
    
    // Check warning
    return this.checkThreshold(
      'response_time',
      'p95',
      p95Ms,
      this.thresholds.responseTimeP95Warning,
      'gt',
      'warning',
    );
  }

  /**
   * Check intent accuracy threshold
   */
  async checkIntentAccuracy(accuracy: number): Promise<Alert | null> {
    return this.checkThreshold(
      'nlu',
      'intent_accuracy',
      accuracy,
      this.thresholds.intentAccuracyWarning,
      'lt',
      'warning',
    );
  }

  /**
   * Check LLM provider failure rate
   */
  async checkLLMFailureRate(provider: string, failureRate: number): Promise<Alert | null> {
    return this.checkThreshold(
      `llm:${provider}`,
      'failure_rate',
      failureRate,
      this.thresholds.llmFailureRateWarning,
      'gt',
      'warning',
    );
  }

  /**
   * Get all active alerts
   */
  async getActiveAlerts(): Promise<Alert[]> {
    try {
      const alertsData = await this.redis.hgetall(this.ALERTS_KEY);
      const alerts: Alert[] = [];
      
      for (const [key, value] of Object.entries(alertsData)) {
        try {
          const alert = JSON.parse(value);
          alert.timestamp = new Date(alert.timestamp);
          alerts.push(alert);
        } catch (e) {
          this.logger.warn(`Failed to parse alert ${key}`);
        }
      }
      
      // Sort by timestamp descending
      alerts.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
      
      return alerts;
    } catch (error) {
      this.logger.error(`Failed to get alerts: ${error.message}`);
      return [];
    }
  }

  /**
   * Acknowledge an alert
   */
  async acknowledgeAlert(alertId: string): Promise<boolean> {
    try {
      const alertsData = await this.redis.hgetall(this.ALERTS_KEY);
      
      for (const [key, value] of Object.entries(alertsData)) {
        const alert = JSON.parse(value);
        if (alert.id === alertId) {
          alert.acknowledged = true;
          await this.redis.hset(this.ALERTS_KEY, key, JSON.stringify(alert));
          
          // Update in-memory
          if (this.activeAlerts.has(key)) {
            this.activeAlerts.get(key)!.acknowledged = true;
          }
          
          this.logger.log(`✅ Alert acknowledged: ${alertId}`);
          return true;
        }
      }
      
      return false;
    } catch (error) {
      this.logger.error(`Failed to acknowledge alert: ${error.message}`);
      return false;
    }
  }

  /**
   * Clear an alert manually
   */
  async clearAlert(alertId: string): Promise<boolean> {
    try {
      const alertsData = await this.redis.hgetall(this.ALERTS_KEY);
      
      for (const [key, value] of Object.entries(alertsData)) {
        const alert = JSON.parse(value);
        if (alert.id === alertId) {
          await this.redis.hdel(this.ALERTS_KEY, key);
          this.activeAlerts.delete(key);
          this.logger.log(`✅ Alert cleared: ${alertId}`);
          return true;
        }
      }
      
      return false;
    } catch (error) {
      this.logger.error(`Failed to clear alert: ${error.message}`);
      return false;
    }
  }

  /**
   * Get alert summary for dashboard
   */
  async getAlertSummary(): Promise<{
    total: number;
    critical: number;
    warning: number;
    acknowledged: number;
    latestAlert?: Alert;
  }> {
    const alerts = await this.getActiveAlerts();
    
    return {
      total: alerts.length,
      critical: alerts.filter(a => a.type === 'critical' && !a.acknowledged).length,
      warning: alerts.filter(a => a.type === 'warning' && !a.acknowledged).length,
      acknowledged: alerts.filter(a => a.acknowledged).length,
      latestAlert: alerts[0],
    };
  }

  /**
   * Format alert message
   */
  private formatAlertMessage(
    component: string,
    metric: string,
    value: number,
    threshold: number,
    comparison: 'gt' | 'lt',
  ): string {
    const operator = comparison === 'gt' ? '>' : '<';
    const formattedValue = metric.includes('time') || metric.includes('latency')
      ? `${value.toFixed(0)}ms`
      : metric.includes('rate') || metric.includes('accuracy')
        ? `${value.toFixed(1)}%`
        : value.toFixed(2);
    const formattedThreshold = metric.includes('time') || metric.includes('latency')
      ? `${threshold}ms`
      : metric.includes('rate') || metric.includes('accuracy')
        ? `${threshold}%`
        : threshold.toString();

    return `${component} ${metric} ${formattedValue} ${operator} threshold ${formattedThreshold}`;
  }

  /**
   * Periodic health check - runs every 5 minutes
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async runHealthCheck() {
    this.logger.debug('Running periodic health check...');
    
    // Check response time from Redis metrics
    try {
      const p95Samples = await this.redis.get('analytics:latency:end_to_end:p95');
      if (p95Samples) {
        await this.checkResponseTime(parseFloat(p95Samples));
      }
    } catch (error) {
      this.logger.error(`Health check failed: ${error.message}`);
    }
  }
}
