import { describe, expect, test } from "bun:test";
import {
  buildTemplatePayload,
  channelHasServiceWindow,
  isWithinServiceWindow,
  proactiveSendMode,
  readServiceWindowConfig,
  SERVICE_WINDOW_DEFAULTS,
} from "@/modules/service-window/service";

const NOW = new Date("2026-06-06T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

describe("readServiceWindowConfig", () => {
  test("defaults: enabled, 24h, no template", () => {
    expect(readServiceWindowConfig(undefined)).toEqual(SERVICE_WINDOW_DEFAULTS);
    expect(readServiceWindowConfig({ serviceWindow: {} }).windowHours).toBe(24);
  });
  test("clamps windowHours and reads template fields", () => {
    const c = readServiceWindowConfig({
      serviceWindow: {
        windowHours: 9999,
        templateName: "reengajamento",
        templateParams: ["{primeiro_nome}", 5, "fixo"],
      },
    });
    expect(c.windowHours).toBe(168);
    expect(c.templateName).toBe("reengajamento");
    expect(c.templateParams).toEqual(["{primeiro_nome}", "fixo"]);
  });
});

describe("isWithinServiceWindow", () => {
  test("null inbound → outside (business-initiated)", () => {
    expect(isWithinServiceWindow(null, NOW, 24)).toBe(false);
  });
  test("recent inbound → inside; old → outside", () => {
    expect(isWithinServiceWindow(hoursAgo(2), NOW, 24)).toBe(true);
    expect(isWithinServiceWindow(hoursAgo(25), NOW, 24)).toBe(false);
  });
});

describe("proactiveSendMode", () => {
  const base = { ...SERVICE_WINDOW_DEFAULTS };
  // Official WhatsApp providers (have a 24h window): Cloud API + 360dialog (provider "default").
  const cloud = channelHasServiceWindow({
    channelType: "Channel::Whatsapp",
    provider: "whatsapp_cloud",
  });
  const dialog360 = channelHasServiceWindow({
    channelType: "Channel::Whatsapp",
    provider: "default",
  });
  test("gate disabled → freeform regardless", () => {
    expect(
      proactiveSendMode({ ...base, enabled: false }, hoursAgo(100), NOW, cloud),
    ).toBe("freeform");
  });
  test("inside window → freeform", () => {
    expect(proactiveSendMode(base, hoursAgo(2), NOW, cloud)).toBe("freeform");
  });
  test("outside window + template → template (Cloud + 360dialog)", () => {
    const withTpl = { ...base, templateName: "reengajamento" };
    expect(proactiveSendMode(withTpl, hoursAgo(48), NOW, cloud)).toBe(
      "template",
    );
    expect(proactiveSendMode(withTpl, hoursAgo(48), NOW, dialog360)).toBe(
      "template",
    );
  });
  test("outside window + no template → note", () => {
    expect(proactiveSendMode(base, hoursAgo(48), NOW, cloud)).toBe("note");
  });
  test("hasWindow=false (e.g. a Z-PRO instance not flagged WABA official) → freeform even outside the window", () => {
    const withTpl = { ...base, templateName: "reengajamento" };
    expect(proactiveSendMode(base, hoursAgo(100), NOW, false)).toBe("freeform");
    expect(proactiveSendMode(withTpl, hoursAgo(100), NOW, false)).toBe(
      "freeform",
    );
  });
});

describe("channelHasServiceWindow", () => {
  test("official WhatsApp providers (Cloud API, 360dialog) have a window", () => {
    expect(
      channelHasServiceWindow({
        channelType: "Channel::Whatsapp",
        provider: "whatsapp_cloud",
      }),
    ).toBe(true);
    expect(
      channelHasServiceWindow({
        channelType: "Channel::Whatsapp",
        provider: "default",
      }),
    ).toBe(true);
  });
  test("unofficial WhatsApp providers (baileys/zapi) have no window", () => {
    for (const provider of ["baileys", "zapi"]) {
      expect(
        channelHasServiceWindow({ channelType: "Channel::Whatsapp", provider }),
      ).toBe(false);
    }
  });
  test("unknown/null provider or non-WhatsApp channel → no window", () => {
    expect(
      channelHasServiceWindow({
        channelType: "Channel::Whatsapp",
        provider: null,
      }),
    ).toBe(false);
    expect(
      channelHasServiceWindow({ channelType: "Channel::Api", provider: null }),
    ).toBe(false);
  });
});

describe("buildTemplatePayload", () => {
  test("interpolates the contact name and builds positional body params", () => {
    const cfg = {
      ...SERVICE_WINDOW_DEFAULTS,
      templateName: "reengajamento",
      templateLanguage: "pt_BR",
      templateParams: ["{{primeiro_nome}}", "promo"],
    };
    const payload = buildTemplatePayload(cfg, "Maria Silva");
    expect(payload).not.toBeNull();
    expect(payload?.name).toBe("reengajamento");
    expect(payload?.language).toBe("pt_BR");
    expect(payload?.processedParams).toEqual({
      body: { "1": "Maria", "2": "promo" },
    });
  });
  test("returns null when no template is configured", () => {
    expect(buildTemplatePayload(SERVICE_WINDOW_DEFAULTS, "Maria")).toBeNull();
  });
});
