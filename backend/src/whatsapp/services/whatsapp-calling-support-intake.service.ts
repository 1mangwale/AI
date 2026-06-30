import { Injectable } from "@nestjs/common";
import { createHash } from "crypto";
import { normalizePhoneNumber } from "../../common/utils/helpers";

export interface WhatsAppCallingSupportIntakeRecord {
  ok: true;
  dry_run: true;
  persisted: false;
  submitted_to_approval_queue: false;
  provider_called: false;
  external_call_performed: false;
  mutation_performed: false;
  raw_pii_returned: false;
  source: "whatsapp-calling-webhook";
  channel: "whatsapp_native_calling";
  direction: "user_initiated";
  intake_type: "manual_support";
  event: string;
  timestamp?: string;
  call_id_hash: string;
  source_event_id_hash: string;
  customer_phone_hash?: string;
  from_phone_hash?: string;
  to_phone_hash?: string;
  wa_id_hash?: string;
  phone_number_id_hash?: string;
  provider_payload_hash: string;
  support_route: {
    queue: "manual_support";
    human_manual_first: true;
    ai_audio_playback_allowed: false;
    outbound_callback_allowed: false;
    order_payment_mutation_allowed: false;
  };
  safe_payload: Record<string, any>;
}

@Injectable()
export class WhatsAppCallingSupportIntakeService {
  buildDryRunIntake(call: any, value: any): WhatsAppCallingSupportIntakeRecord {
    const event = (
      this.firstNonEmptyString(call?.event, call?.status, call?.type) ||
      "unknown"
    ).toLowerCase();
    const timestamp = this.firstNonEmptyString(call?.timestamp);
    const callIdSource = this.firstNonEmptyString(
      call?.id,
      call?.call_id,
      call?.callId,
      `${event}:${timestamp || "unknown"}`,
    ) as string;
    const callIdHash = this.sha256(callIdSource);
    const fromHash = this.phoneHash(
      call?.from,
      call?.from_phone_number,
      call?.fromPhoneNumber,
    );
    const toHash = this.phoneHash(
      call?.to,
      call?.to_phone_number,
      call?.toPhoneNumber,
    );
    const contact = Array.isArray(value?.contacts)
      ? value.contacts[0]
      : undefined;
    const waIdHash = this.phoneHash(contact?.wa_id);
    const phoneNumberId = this.firstNonEmptyString(
      value?.metadata?.phone_number_id,
    );
    const phoneNumberIdHash = phoneNumberId
      ? this.sha256(phoneNumberId)
      : undefined;
    const customerPhoneHash = fromHash || waIdHash;
    const safePayload = this.omitUndefined({
      messaging_product: value?.messaging_product,
      event,
      timestamp,
      call_id_hash: callIdHash,
      from_phone_hash: fromHash,
      to_phone_hash: toHash,
      wa_id_hash: waIdHash,
      phone_number_id_hash: phoneNumberIdHash,
      contact_count: Array.isArray(value?.contacts)
        ? value.contacts.length
        : undefined,
      raw_contact_fields_allowed: false,
      provider_called: false,
      external_call_performed: false,
      mutation_performed: false,
    });

    return {
      ok: true,
      dry_run: true,
      persisted: false,
      submitted_to_approval_queue: false,
      provider_called: false,
      external_call_performed: false,
      mutation_performed: false,
      raw_pii_returned: false,
      source: "whatsapp-calling-webhook",
      channel: "whatsapp_native_calling",
      direction: "user_initiated",
      intake_type: "manual_support",
      event,
      timestamp,
      call_id_hash: callIdHash,
      source_event_id_hash: callIdHash,
      customer_phone_hash: customerPhoneHash,
      from_phone_hash: fromHash,
      to_phone_hash: toHash,
      wa_id_hash: waIdHash,
      phone_number_id_hash: phoneNumberIdHash,
      provider_payload_hash: this.sha256(JSON.stringify(safePayload)),
      support_route: {
        queue: "manual_support",
        human_manual_first: true,
        ai_audio_playback_allowed: false,
        outbound_callback_allowed: false,
        order_payment_mutation_allowed: false,
      },
      safe_payload: safePayload,
    };
  }

  private phoneHash(...values: any[]): string | undefined {
    const raw = this.firstNonEmptyString(...values);
    if (!raw) {
      return undefined;
    }
    const normalized = normalizePhoneNumber(raw) || raw;
    return this.sha256(normalized);
  }

  private firstNonEmptyString(...values: any[]): string | undefined {
    for (const value of values) {
      if (value === undefined || value === null) {
        continue;
      }
      const text = String(value).trim();
      if (text) {
        return text;
      }
    }
    return undefined;
  }

  private omitUndefined<T extends Record<string, any>>(value: T): T {
    return Object.fromEntries(
      Object.entries(value).filter(([, entry]) => entry !== undefined),
    ) as T;
  }

  private sha256(value: string): string {
    return createHash("sha256").update(value).digest("hex");
  }
}
