import { WhatsAppCallingSupportIntakeService } from "./whatsapp-calling-support-intake.service";

describe("WhatsAppCallingSupportIntakeService", () => {
  it("normalizes call webhook events into dry-run hash-only support intake", () => {
    const service = new WhatsAppCallingSupportIntakeService();

    const record = service.buildDryRunIntake(
      {
        id: "wamid.call.raw-id-1",
        event: "connect",
        from: "919876543210",
        to: "911234567890",
        timestamp: "1782825000",
      },
      {
        messaging_product: "whatsapp",
        metadata: { phone_number_id: "123456789" },
        contacts: [{ wa_id: "919876543210", profile: { name: "Raw Name" } }],
      },
    );

    const serialized = JSON.stringify(record);
    expect(record.dry_run).toBe(true);
    expect(record.persisted).toBe(false);
    expect(record.provider_called).toBe(false);
    expect(record.external_call_performed).toBe(false);
    expect(record.mutation_performed).toBe(false);
    expect(record.raw_pii_returned).toBe(false);
    expect(record.direction).toBe("user_initiated");
    expect(record.support_route.human_manual_first).toBe(true);
    expect(record.support_route.ai_audio_playback_allowed).toBe(false);
    expect(serialized).not.toContain("919876543210");
    expect(serialized).not.toContain("911234567890");
    expect(serialized).not.toContain("123456789");
    expect(serialized).not.toContain("Raw Name");
    expect(record.call_id_hash).toHaveLength(64);
    expect(record.customer_phone_hash).toHaveLength(64);
    expect(record.provider_payload_hash).toHaveLength(64);
  });
});
