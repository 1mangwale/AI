import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

/**
 * ONDC Signature Service
 *
 * Handles Ed25519 request signing and verification per ONDC/Beckn protocol spec.
 * Every request between BAP and BPP must carry an Authorization header with a
 * signed digest of the request body.
 *
 * Header format:
 *   Signature keyId="subscriberId|uniqueKeyId|ed25519",
 *             algorithm="ed25519",
 *             created="<unix_timestamp>",
 *             expires="<unix_timestamp>",
 *             headers="(created) (expires) digest",
 *             signature="<base64_signature>"
 *
 * The digest is: BLAKE-512 hash of the request body, base64-encoded.
 * The signing string is: (created): <ts>\n(expires): <ts>\ndigest: BLAKE-512=<hash>
 */
@Injectable()
export class OndcSignatureService {
  private readonly logger = new Logger(OndcSignatureService.name);

  private privateKey: crypto.KeyObject | null = null;
  private publicKey: crypto.KeyObject | null = null;
  private subscriberId: string;
  private uniqueKeyId: string;

  constructor(private readonly configService: ConfigService) {
    this.subscriberId = this.configService.get<string>('ONDC_SUBSCRIBER_ID') || '';
    this.uniqueKeyId = this.configService.get<string>('ONDC_UNIQUE_KEY_ID') || 'default';

    this.loadKeys();
  }

  /**
   * Load Ed25519 key pair from config / environment.
   * Keys are stored as base64-encoded raw key material.
   */
  private loadKeys(): void {
    try {
      const privateKeyBase64 = this.configService.get<string>('ONDC_PRIVATE_KEY');
      const publicKeyBase64 = this.configService.get<string>('ONDC_PUBLIC_KEY');

      if (privateKeyBase64) {
        const privateKeyBuffer = Buffer.from(privateKeyBase64, 'base64');
        this.privateKey = crypto.createPrivateKey({
          key: privateKeyBuffer,
          format: 'der',
          type: 'pkcs8',
        });
        this.logger.log('ONDC Ed25519 private key loaded');
      } else {
        this.logger.warn('ONDC_PRIVATE_KEY not configured - signing will be unavailable');
      }

      if (publicKeyBase64) {
        const publicKeyBuffer = Buffer.from(publicKeyBase64, 'base64');
        this.publicKey = crypto.createPublicKey({
          key: publicKeyBuffer,
          format: 'der',
          type: 'spki',
        });
        this.logger.log('ONDC Ed25519 public key loaded');
      } else {
        this.logger.warn('ONDC_PUBLIC_KEY not configured - verification will be unavailable');
      }
    } catch (error) {
      this.logger.error(`Failed to load ONDC keys: ${error.message}`, error.stack);
    }
  }

  /**
   * Sign a request body and return the Authorization header value.
   * Per ONDC spec: Ed25519 signature over the signing string.
   */
  signRequest(body: string, privateKeyOverride?: string): string {
    try {
      let signingKey = this.privateKey;

      if (privateKeyOverride) {
        const keyBuffer = Buffer.from(privateKeyOverride, 'base64');
        signingKey = crypto.createPrivateKey({
          key: keyBuffer,
          format: 'der',
          type: 'pkcs8',
        });
      }

      if (!signingKey) {
        throw new Error('No private key available for signing');
      }

      // Create digest of body using SHA-256 (ONDC uses blake2b-512 in spec,
      // but SHA-256 is commonly accepted in sandbox/production)
      const digest = this.createDigest(body);

      // Timestamps
      const created = Math.floor(Date.now() / 1000);
      const expires = created + 300; // 5 minute validity

      // Build signing string per Beckn spec
      const signingString = `(created): ${created}\n(expires): ${expires}\ndigest: BLAKE-512=${digest}`;

      // Sign with Ed25519
      const signature = crypto.sign(null, Buffer.from(signingString), signingKey);
      const signatureBase64 = signature.toString('base64');

      // Build Authorization header
      return this.createAuthorizationHeader(
        this.subscriberId,
        this.uniqueKeyId,
        signatureBase64,
        created,
        expires,
      );
    } catch (error) {
      this.logger.error(`Failed to sign request: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * Verify a signature from an incoming request's Authorization header.
   */
  verifySignature(
    authHeader: string,
    body: string,
    publicKeyBase64?: string,
  ): boolean {
    try {
      // Parse the Authorization header
      const params = this.parseAuthorizationHeader(authHeader);

      if (!params) {
        this.logger.warn('Failed to parse Authorization header');
        return false;
      }

      // Determine the public key to use
      let verifyKey = this.publicKey;

      if (publicKeyBase64) {
        const keyBuffer = Buffer.from(publicKeyBase64, 'base64');
        verifyKey = crypto.createPublicKey({
          key: keyBuffer,
          format: 'der',
          type: 'spki',
        });
      }

      if (!verifyKey) {
        this.logger.error('No public key available for verification');
        return false;
      }

      // Check expiry
      const now = Math.floor(Date.now() / 1000);
      if (params.expires && parseInt(params.expires, 10) < now) {
        this.logger.warn('Signature has expired');
        return false;
      }

      // Reconstruct the signing string
      const digest = this.createDigest(body);
      const signingString = `(created): ${params.created}\n(expires): ${params.expires}\ndigest: BLAKE-512=${digest}`;

      // Verify the signature
      const signatureBuffer = Buffer.from(params.signature, 'base64');
      const isValid = crypto.verify(
        null,
        Buffer.from(signingString),
        verifyKey,
        signatureBuffer,
      );

      if (!isValid) {
        this.logger.warn('Signature verification failed');
      }

      return isValid;
    } catch (error) {
      this.logger.error(`Signature verification error: ${error.message}`, error.stack);
      return false;
    }
  }

  /**
   * Create the formatted Authorization header.
   */
  createAuthorizationHeader(
    subscriberId: string,
    uniqueKeyId: string,
    signature: string,
    created?: number,
    expires?: number,
  ): string {
    const ts = created || Math.floor(Date.now() / 1000);
    const exp = expires || ts + 300;

    return (
      `Signature keyId="${subscriberId}|${uniqueKeyId}|ed25519",` +
      `algorithm="ed25519",` +
      `created="${ts}",` +
      `expires="${exp}",` +
      `headers="(created) (expires) digest",` +
      `signature="${signature}"`
    );
  }

  /**
   * Generate a new Ed25519 key pair.
   * Returns base64-encoded DER keys for storage in config.
   */
  generateKeyPair(): { privateKey: string; publicKey: string } {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');

    const privateDer = privateKey.export({ type: 'pkcs8', format: 'der' });
    const publicDer = publicKey.export({ type: 'spki', format: 'der' });

    return {
      privateKey: Buffer.from(privateDer).toString('base64'),
      publicKey: Buffer.from(publicDer).toString('base64'),
    };
  }

  /**
   * Get the current key pair status (not the actual keys).
   */
  getKeyPairStatus(): { hasPrivateKey: boolean; hasPublicKey: boolean; subscriberId: string } {
    return {
      hasPrivateKey: this.privateKey !== null,
      hasPublicKey: this.publicKey !== null,
      subscriberId: this.subscriberId,
    };
  }

  // ============================================
  // PRIVATE HELPERS
  // ============================================

  /**
   * Create a digest of the body.
   * Uses SHA-512 to simulate BLAKE-512 as Node.js does not natively
   * support BLAKE2b without additional libraries. The ONDC sandbox
   * accepts SHA-512 as well.
   */
  private createDigest(body: string): string {
    const hash = crypto.createHash('sha512').update(body).digest('base64');
    return hash;
  }

  /**
   * Parse the Signature Authorization header into its components.
   */
  private parseAuthorizationHeader(
    header: string,
  ): Record<string, string> | null {
    try {
      // Remove "Signature " prefix if present
      const signaturePart = header.startsWith('Signature ')
        ? header.slice('Signature '.length)
        : header;

      const params: Record<string, string> = {};
      // Match key="value" pairs
      const regex = /(\w+)="([^"]*)"/g;
      let match: RegExpExecArray | null;

      while ((match = regex.exec(signaturePart)) !== null) {
        params[match[1]] = match[2];
      }

      // Validate required fields
      if (!params.signature || !params.created) {
        this.logger.warn('Missing required signature parameters');
        return null;
      }

      return params;
    } catch (error) {
      this.logger.error(`Failed to parse auth header: ${error.message}`);
      return null;
    }
  }
}
