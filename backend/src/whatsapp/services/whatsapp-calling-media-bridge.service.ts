import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { WhatsAppCallingSupportIntakeRecord } from "./whatsapp-calling-support-intake.service";

/**
 * The last link in the WhatsApp calling lane.
 *
 * Everything else in this module is governance: who may be called, when, and
 * with what approval. None of it ever answered a call, because answering one
 * means returning an SDP answer and carrying SRTP audio, and there is no media
 * code in this backend at all.
 *
 * That media lives on mercury (`wa-call-bridge`, aiortc), which terminates
 * WebRTC and speaks the orchestrator's `/ws/exotel` protocol upstream -- so a
 * WhatsApp caller reaches the same Vikram, ASR, LLM and handoff as a PSTN
 * caller. This service is the seam: it hands the offer over, gets the answer
 * back, and does the Graph pre_accept/accept itself, because the access token
 * belongs here and must not be copied onto the media box.
 *
 * Fail-closed by design. Off unless WHATSAPP_CALLING_MEDIA_BRIDGE_ENABLED is
 * true, and even then only for callers whose phone hash is in
 * WHATSAPP_CALLING_INTERNAL_TEST_ALLOWLIST_HASHES -- the same allowlist the
 * live executor gates on. An empty allowlist answers nobody.
 */
@Injectable()
export class WhatsAppCallingMediaBridgeService {
  private readonly logger = new Logger(WhatsAppCallingMediaBridgeService.name);

  constructor(private readonly config: ConfigService) {}

  async handleCallEvent(
    call: any,
    intake: WhatsAppCallingSupportIntakeRecord,
  ): Promise<void> {
    const event = String(intake.event || "").toLowerCase();
    if (event === "connect") {
      await this.answerCall(call, intake);
      return;
    }
    if (["terminate", "reject", "timeout", "failed"].includes(event)) {
      await this.releaseCall(call?.id, event);
    }
  }

  private async answerCall(
    call: any,
    intake: WhatsAppCallingSupportIntakeRecord,
  ): Promise<void> {
    const shortId = this.shortId(intake.call_id_hash);
    if (!this.flag("WHATSAPP_CALLING_MEDIA_BRIDGE_ENABLED")) {
      this.logger.log(
        `call ${shortId}: media bridge disabled — left unanswered (dry-run only)`,
      );
      return;
    }

    const allowlist = this.allowlist();
    if (allowlist.size === 0) {
      this.logger.warn(
        `call ${shortId}: bridge enabled but WHATSAPP_CALLING_INTERNAL_TEST_ALLOWLIST_HASHES is empty — refusing to answer`,
      );
      return;
    }
    if (
      !intake.customer_phone_hash ||
      !allowlist.has(intake.customer_phone_hash.toLowerCase())
    ) {
      this.logger.log(
        `call ${shortId}: caller is not on the internal allowlist — left unanswered`,
      );
      return;
    }

    const sdp = call?.session?.sdp;
    const sdpType = String(call?.session?.sdp_type || "");
    if (!sdp || sdpType !== "offer") {
      this.logger.warn(
        `call ${shortId}: connect event carried no SDP offer (sdp_type=${sdpType || "none"})`,
      );
      return;
    }

    const callId = String(call?.id || "");
    let answer: string;
    try {
      const res = await this.postJson(`${this.bridgeUrl()}/wa/offer`, {
        call_id: callId,
        sdp,
        sdp_type: "offer",
        caller: String(call?.from || ""),
        role: this.config.get<string>("WHATSAPP_CALLING_BRIDGE_ROLE") || "support",
      });
      answer = String(res?.sdp || "");
      if (!answer) throw new Error("bridge returned no answer sdp");
    } catch (error: any) {
      this.logger.error(
        `call ${shortId}: media bridge could not answer — ${error?.message}`,
      );
      return;
    }

    try {
      // pre_accept first so media can start flowing before the ring is
      // accepted; without it the caller hears the first second of silence
      // while DTLS is still negotiating.
      await this.graphCall(callId, "pre_accept", answer);
      await this.graphCall(callId, "accept", answer);
      this.logger.log(`call ${shortId}: answered and bridged to the voice brain`);
    } catch (error: any) {
      this.logger.error(
        `call ${shortId}: Graph accept failed — ${error?.message}; releasing the bridge`,
      );
      await this.releaseCall(callId, "graph accept failed");
    }
  }

  private async releaseCall(callId: string | undefined, reason: string): Promise<void> {
    if (!callId || !this.flag("WHATSAPP_CALLING_MEDIA_BRIDGE_ENABLED")) return;
    try {
      await this.postJson(`${this.bridgeUrl()}/wa/terminate`, {
        call_id: callId,
        reason,
      });
    } catch (error: any) {
      this.logger.warn(`bridge release failed (${reason}): ${error?.message}`);
    }
  }

  private async graphCall(
    callId: string,
    action: "pre_accept" | "accept",
    sdp: string,
  ): Promise<void> {
    // Same namespaced config the rest of the WhatsApp module reads, so the
    // token and phone number id can never drift from the ones the webhook
    // controller already authenticates with.
    const version = this.config.get<string>("whatsapp.apiVersion") || "v24.0";
    const phoneNumberId = this.config.get<string>("whatsapp.phoneNumberId");
    const token = this.config.get<string>("whatsapp.accessToken");
    if (!phoneNumberId || !token) {
      throw new Error(
        "WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN not configured",
      );
    }
    const url = `https://graph.facebook.com/${version}/${phoneNumberId}/calls`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        call_id: callId,
        action,
        session: { sdp_type: "answer", sdp },
      }),
    });
    if (!response.ok) {
      // Meta's SDP rejection carries its only useful detail in error_user_msg,
      // which sits past the 200-char mark — truncating here once cost a whole
      // live call to discover.
      const text = await response.text();
      throw new Error(`${action} -> HTTP ${response.status} ${text.slice(0, 1500)}`);
    }
  }

  private async postJson(url: string, body: Record<string, any>): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
      }
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  private bridgeUrl(): string {
    return (
      this.config.get<string>("WHATSAPP_CALLING_BRIDGE_URL") ||
      "http://100.117.131.56:7300"
    ).replace(/\/$/, "");
  }

  private allowlist(): Set<string> {
    const raw = String(
      this.config.get<string>("WHATSAPP_CALLING_INTERNAL_TEST_ALLOWLIST_HASHES") || "",
    );
    return new Set(
      raw
        .split(",")
        .map((item) => item.trim().toLowerCase())
        .filter((item) => /^[a-f0-9]{64}$/.test(item)),
    );
  }

  private flag(key: string): boolean {
    return ["1", "true", "yes", "on"].includes(
      String(this.config.get<string>(key) || "").trim().toLowerCase(),
    );
  }

  private shortId(callIdHash: string): string {
    return callIdHash ? callIdHash.slice(0, 12) : "unknown";
  }
}
