import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

export interface DecryptedFlowRequest {
  decryptedData: any;
  aesKey: Buffer;
  iv: Buffer;
}

/**
 * WhatsApp Flow Encryption Service
 *
 * Implements AES-128-GCM encryption required by Meta for WhatsApp Flow
 * data-exchange endpoints in production.
 *
 * Protocol (RSA + AES-GCM hybrid):
 *   1. Meta encrypts a random 128-bit AES key with our RSA public key (RSA-OAEP, SHA-256)
 *   2. Meta encrypts the flow payload with that AES key using AES-128-GCM
 *   3. We decrypt the AES key with our RSA private key
 *   4. We decrypt the payload with the AES key + IV
 *   5. We process the request (existing business logic)
 *   6. We encrypt the response with the same AES key + flipped IV
 *   7. We return base64-encoded ciphertext as text/plain
 *
 * Setup:
 *   openssl genrsa -out wa_flow_private.pem 2048
 *   openssl rsa -in wa_flow_private.pem -pubout -out wa_flow_public.pem
 *   Upload public key to Meta via WhatsApp Manager → Flows → Business encryption key
 *   Set WHATSAPP_FLOW_PRIVATE_KEY env var (PEM string or base64-encoded PEM)
 */
@Injectable()
export class WhatsAppFlowEncryptionService {
  private readonly logger = new Logger(WhatsAppFlowEncryptionService.name);
  private privateKey: string | null = null;
  private enabled = false;

  constructor(private readonly configService: ConfigService) {
    const rawKey = this.configService.get<string>('WHATSAPP_FLOW_PRIVATE_KEY');

    if (rawKey) {
      try {
        // Support both raw PEM and base64-encoded PEM
        if (rawKey.includes('-----BEGIN')) {
          this.privateKey = rawKey;
        } else {
          this.privateKey = Buffer.from(rawKey, 'base64').toString('utf-8');
        }

        // Validate the key can be parsed
        crypto.createPrivateKey(this.privateKey);
        this.enabled = true;
        this.logger.log('WhatsApp Flow encryption enabled (RSA + AES-128-GCM)');
      } catch (err) {
        this.logger.error(`Invalid WHATSAPP_FLOW_PRIVATE_KEY: ${err.message}`);
        this.privateKey = null;
      }
    } else {
      this.logger.warn('WhatsApp Flow encryption disabled — WHATSAPP_FLOW_PRIVATE_KEY not set');
    }
  }

  /**
   * Whether encryption is enabled (private key configured and valid)
   */
  isEncryptionEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Check if an incoming request body is encrypted (has encrypted_aes_key field)
   */
  isEncryptedRequest(body: any): boolean {
    return !!(body?.encrypted_aes_key && body?.encrypted_flow_data && body?.initial_vector);
  }

  /**
   * Decrypt an incoming WhatsApp Flow request
   *
   * @param body - { encrypted_aes_key, encrypted_flow_data, initial_vector } (all base64)
   * @returns Decrypted JSON payload + AES key + IV for response encryption
   */
  decryptRequest(body: {
    encrypted_aes_key: string;
    encrypted_flow_data: string;
    initial_vector: string;
  }): DecryptedFlowRequest {
    if (!this.privateKey) {
      throw new Error('Flow encryption not configured — missing private key');
    }

    // Step 1: RSA-OAEP decrypt the AES key
    const encryptedAesKey = Buffer.from(body.encrypted_aes_key, 'base64');
    const aesKey = crypto.privateDecrypt(
      {
        key: this.privateKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      encryptedAesKey,
    );

    // Step 2: Decode IV and encrypted data
    const iv = Buffer.from(body.initial_vector, 'base64');
    const encryptedFlowData = Buffer.from(body.encrypted_flow_data, 'base64');

    // Step 3: Split auth tag (last 16 bytes) from ciphertext
    const authTag = encryptedFlowData.slice(-16);
    const ciphertext = encryptedFlowData.slice(0, -16);

    // Step 4: AES-128-GCM decrypt
    const decipher = crypto.createDecipheriv('aes-128-gcm', aesKey, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    const decryptedData = JSON.parse(decrypted.toString('utf-8'));

    return { decryptedData, aesKey, iv };
  }

  /**
   * Encrypt a response for WhatsApp Flow
   *
   * @param responseData - JSON object to encrypt
   * @param aesKey - Same AES key from decryptRequest
   * @param iv - Same IV from decryptRequest (will be flipped)
   * @returns Base64-encoded encrypted response (ciphertext + auth tag)
   */
  encryptResponse(responseData: any, aesKey: Buffer, iv: Buffer): string {
    // Step 1: Flip IV bits (XOR each byte with 0xFF)
    const flippedIv = Buffer.from(iv.map(b => ~b & 0xff));

    // Step 2: AES-128-GCM encrypt
    const cipher = crypto.createCipheriv('aes-128-gcm', aesKey, flippedIv);
    const plaintext = JSON.stringify(responseData);

    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf-8'),
      cipher.final(),
    ]);

    // Step 3: Append auth tag
    const authTag = cipher.getAuthTag();

    // Step 4: Concatenate ciphertext + auth tag and base64 encode
    return Buffer.concat([encrypted, authTag]).toString('base64');
  }
}
