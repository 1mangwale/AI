import { Injectable, Logger } from '@nestjs/common';

/**
 * 🔌 Circuit Breaker Service
 * 
 * Protects the system from cascading failures:
 * - Monitors external API failures
 * - Opens circuit after threshold failures
 * - Half-opens to test recovery
 * - Closes when service recovers
 * 
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Failures exceeded threshold, requests fail fast
 * - HALF_OPEN: Testing if service recovered, limited requests
 */

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerConfig {
  failureThreshold: number;     // Failures before opening (default: 5)
  successThreshold: number;     // Successes to close from half-open (default: 3)
  openDurationMs: number;       // How long to stay open (default: 30000)
  halfOpenMaxRequests: number;  // Max requests in half-open (default: 3)
  windowSizeMs: number;         // Time window for counting failures (default: 60000)
}

interface CircuitStats {
  failures: number;
  successes: number;
  consecutiveFailures: number;
  lastFailureTime: Date | null;
  lastSuccessTime: Date | null;
  openedAt: Date | null;
  halfOpenRequests: number;
}

interface Circuit {
  name: string;
  state: CircuitState;
  config: CircuitBreakerConfig;
  stats: CircuitStats;
}

@Injectable()
export class CircuitBreakerService {
  private readonly logger = new Logger(CircuitBreakerService.name);
  private circuits: Map<string, Circuit> = new Map();

  private readonly defaultConfig: CircuitBreakerConfig = {
    failureThreshold: 5,
    successThreshold: 3,
    openDurationMs: 30000,
    halfOpenMaxRequests: 3,
    windowSizeMs: 60000,
  };

  constructor() {
    this.logger.log('🔌 CircuitBreakerService initialized');
  }

  /**
   * Create or get a circuit breaker
   */
  getCircuit(name: string, config?: Partial<CircuitBreakerConfig>): Circuit {
    let circuit = this.circuits.get(name);
    
    if (!circuit) {
      circuit = {
        name,
        state: 'CLOSED',
        config: { ...this.defaultConfig, ...config },
        stats: {
          failures: 0,
          successes: 0,
          consecutiveFailures: 0,
          lastFailureTime: null,
          lastSuccessTime: null,
          openedAt: null,
          halfOpenRequests: 0,
        },
      };
      this.circuits.set(name, circuit);
      this.logger.log(`🔌 Circuit breaker created: ${name}`);
    }

    return circuit;
  }

  /**
   * Check if request should be allowed
   */
  canExecute(name: string): boolean {
    const circuit = this.getCircuit(name);
    
    switch (circuit.state) {
      case 'CLOSED':
        return true;

      case 'OPEN':
        // Check if should transition to half-open
        if (circuit.stats.openedAt) {
          const elapsed = Date.now() - circuit.stats.openedAt.getTime();
          if (elapsed >= circuit.config.openDurationMs) {
            this.transitionToHalfOpen(circuit);
            return circuit.stats.halfOpenRequests < circuit.config.halfOpenMaxRequests;
          }
        }
        return false;

      case 'HALF_OPEN':
        // Allow limited requests in half-open
        if (circuit.stats.halfOpenRequests < circuit.config.halfOpenMaxRequests) {
          circuit.stats.halfOpenRequests++;
          return true;
        }
        return false;

      default:
        return false;
    }
  }

  /**
   * Execute a function with circuit breaker protection
   */
  async execute<T>(name: string, fn: () => Promise<T>, fallback?: () => T | Promise<T>): Promise<T> {
    if (!this.canExecute(name)) {
      this.logger.warn(`⚡ Circuit OPEN for ${name}, using fallback`);
      if (fallback) {
        return fallback();
      }
      throw new Error(`Circuit breaker is OPEN for ${name}`);
    }

    try {
      const result = await fn();
      this.recordSuccess(name);
      return result;
    } catch (error) {
      // Don't count client auth errors (401) as circuit breaker failures
      if ((error as any)?.skipCircuitBreaker) {
        this.logger.debug(`⚡ Skipping circuit breaker failure for ${name} (skipCircuitBreaker=true)`);
      } else {
        this.recordFailure(name);
      }

      if (fallback) {
        return fallback();
      }
      throw error;
    }
  }

  /**
   * Record a successful request
   */
  recordSuccess(name: string): void {
    const circuit = this.getCircuit(name);
    circuit.stats.successes++;
    circuit.stats.consecutiveFailures = 0;
    circuit.stats.lastSuccessTime = new Date();

    if (circuit.state === 'HALF_OPEN') {
      // Check if enough successes to close
      const recentSuccesses = circuit.stats.successes; // In real impl, track within window
      if (recentSuccesses >= circuit.config.successThreshold) {
        this.transitionToClosed(circuit);
      }
    }
  }

  /**
   * Record a failed request
   */
  recordFailure(name: string): void {
    const circuit = this.getCircuit(name);
    circuit.stats.failures++;
    circuit.stats.consecutiveFailures++;
    circuit.stats.lastFailureTime = new Date();

    if (circuit.state === 'HALF_OPEN') {
      // Any failure in half-open returns to open
      this.transitionToOpen(circuit);
      return;
    }

    if (circuit.state === 'CLOSED') {
      // Check if should open
      if (circuit.stats.consecutiveFailures >= circuit.config.failureThreshold) {
        this.transitionToOpen(circuit);
      }
    }
  }

  /**
   * Transition to OPEN state
   */
  private transitionToOpen(circuit: Circuit): void {
    if (circuit.state !== 'OPEN') {
      circuit.state = 'OPEN';
      circuit.stats.openedAt = new Date();
      circuit.stats.halfOpenRequests = 0;
      this.logger.warn(`🔴 Circuit OPENED: ${circuit.name} (${circuit.stats.consecutiveFailures} consecutive failures)`);
    }
  }

  /**
   * Transition to HALF_OPEN state
   */
  private transitionToHalfOpen(circuit: Circuit): void {
    if (circuit.state !== 'HALF_OPEN') {
      circuit.state = 'HALF_OPEN';
      circuit.stats.halfOpenRequests = 0;
      circuit.stats.successes = 0; // Reset for counting in half-open
      this.logger.log(`🟡 Circuit HALF-OPEN: ${circuit.name} (testing recovery)`);
    }
  }

  /**
   * Transition to CLOSED state
   */
  private transitionToClosed(circuit: Circuit): void {
    if (circuit.state !== 'CLOSED') {
      circuit.state = 'CLOSED';
      circuit.stats.failures = 0;
      circuit.stats.consecutiveFailures = 0;
      circuit.stats.openedAt = null;
      circuit.stats.halfOpenRequests = 0;
      this.logger.log(`🟢 Circuit CLOSED: ${circuit.name} (recovered)`);
    }
  }

  /**
   * Manually reset a circuit
   */
  reset(name: string): void {
    const circuit = this.circuits.get(name);
    if (circuit) {
      this.transitionToClosed(circuit);
      circuit.stats = {
        failures: 0,
        successes: 0,
        consecutiveFailures: 0,
        lastFailureTime: null,
        lastSuccessTime: null,
        openedAt: null,
        halfOpenRequests: 0,
      };
      this.logger.log(`🔄 Circuit RESET: ${name}`);
    }
  }

  /**
   * Get circuit status
   */
  getStatus(name: string): {
    name: string;
    state: CircuitState;
    failures: number;
    consecutiveFailures: number;
    lastFailure: Date | null;
    lastSuccess: Date | null;
    openedAt: Date | null;
    config: CircuitBreakerConfig;
  } | null {
    const circuit = this.circuits.get(name);
    if (!circuit) return null;

    // Check if should update state
    if (circuit.state === 'OPEN' && circuit.stats.openedAt) {
      const elapsed = Date.now() - circuit.stats.openedAt.getTime();
      if (elapsed >= circuit.config.openDurationMs) {
        this.transitionToHalfOpen(circuit);
      }
    }

    return {
      name: circuit.name,
      state: circuit.state,
      failures: circuit.stats.failures,
      consecutiveFailures: circuit.stats.consecutiveFailures,
      lastFailure: circuit.stats.lastFailureTime,
      lastSuccess: circuit.stats.lastSuccessTime,
      openedAt: circuit.stats.openedAt,
      config: circuit.config,
    };
  }

  /**
   * Get all circuits status
   */
  getAllStatus(): Array<{
    name: string;
    state: CircuitState;
    failures: number;
    consecutiveFailures: number;
  }> {
    return Array.from(this.circuits.values()).map(circuit => ({
      name: circuit.name,
      state: circuit.state,
      failures: circuit.stats.failures,
      consecutiveFailures: circuit.stats.consecutiveFailures,
    }));
  }

  /**
   * Update circuit configuration
   */
  updateConfig(name: string, config: Partial<CircuitBreakerConfig>): void {
    const circuit = this.getCircuit(name);
    circuit.config = { ...circuit.config, ...config };
    this.logger.log(`⚙️ Circuit config updated: ${name}`);
  }

  /**
   * Create pre-configured circuits for common services
   */
  initializeDefaultCircuits(): void {
    // LLM services (more tolerant, slower recovery)
    this.getCircuit('vllm', {
      failureThreshold: 3,
      successThreshold: 2,
      openDurationMs: 60000, // 1 minute
    });

    this.getCircuit('groq', {
      failureThreshold: 5,
      successThreshold: 3,
      openDurationMs: 30000,
    });

    this.getCircuit('openai', {
      failureThreshold: 5,
      successThreshold: 3,
      openDurationMs: 30000,
    });

    // External services (quick failover)
    this.getCircuit('php-backend', {
      failureThreshold: 3,
      successThreshold: 2,
      openDurationMs: 15000,
    });

    this.getCircuit('opensearch', {
      failureThreshold: 3,
      successThreshold: 2,
      openDurationMs: 15000,
    });

    this.getCircuit('whatsapp-api', {
      failureThreshold: 5,
      successThreshold: 3,
      openDurationMs: 30000,
    });

    this.getCircuit('twilio', {
      failureThreshold: 5,
      successThreshold: 3,
      openDurationMs: 30000,
    });

    this.logger.log('🔌 Default circuit breakers initialized');
  }
}
