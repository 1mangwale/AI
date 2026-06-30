import "reflect-metadata";
import { MODULE_METADATA } from "@nestjs/common/constants";
import { ApprovalModule } from "../approval/approval.module";
import { WhatsAppModule } from "./whatsapp.module";

describe("WhatsAppModule", () => {
  it("imports ApprovalModule for WhatsApp calling executor approval checks", () => {
    const imports =
      Reflect.getMetadata(MODULE_METADATA.IMPORTS, WhatsAppModule) || [];

    expect(imports).toContain(ApprovalModule);
  });
});
