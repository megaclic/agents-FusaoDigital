// tests/modules/zpro/messages.test.ts
// sendZproTemplate: builds the WABA components shape (Meta Cloud API standard, BODY-only —
// OPEN-VALIDATION, see docs/service-window.md) from a TemplatePayload and posts it via
// ZproClient.sendTemplateWABABody. Pure enough to test with a mock client (no DB, no network).

import { describe, expect, mock, test } from "bun:test";
import type { TemplatePayload } from "@/modules/service-window/service";
import type { ZproClient } from "@/modules/zpro/client";
import { sendZproTemplate } from "@/modules/zpro/messages";

function fakeClient() {
  const calls: unknown[] = [];
  const client = {
    sendTemplateWABABody: mock(async (data: unknown) => {
      calls.push(data);
      return {};
    }),
  } as unknown as ZproClient;
  return { client, calls };
}

describe("sendZproTemplate", () => {
  test("builds ordered body parameters into a single BODY component", async () => {
    const { client, calls } = fakeClient();
    const payload: TemplatePayload = {
      content: "Oi Maria, promo!",
      name: "reengajamento",
      category: "UTILITY",
      language: "pt_BR",
      processedParams: { body: { "1": "Maria", "2": "promo" } },
    };
    await sendZproTemplate(client, "5511999990000", payload);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      number: "5511999990000",
      templateName: "reengajamento",
      languageCode: "pt_BR",
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: "Maria" },
            { type: "text", text: "promo" },
          ],
        },
      ],
    });
  });

  test("orders parameters numerically, not lexically (param 10 after param 2)", async () => {
    const { client, calls } = fakeClient();
    const body: Record<string, string> = {};
    for (let i = 1; i <= 10; i++) body[String(i)] = `v${i}`;
    const payload: TemplatePayload = {
      content: "x",
      name: "t",
      category: "UTILITY",
      language: "pt_BR",
      processedParams: { body },
    };
    await sendZproTemplate(client, "5511999990000", payload);
    const sent = calls[0] as {
      components: { parameters: { text: string }[] }[];
    };
    expect(sent.components[0]?.parameters.map((p) => p.text)).toEqual([
      "v1",
      "v2",
      "v3",
      "v4",
      "v5",
      "v6",
      "v7",
      "v8",
      "v9",
      "v10",
    ]);
  });

  test("omits components entirely when there are no body params", async () => {
    const { client, calls } = fakeClient();
    const payload: TemplatePayload = {
      content: "sem parâmetros",
      name: "aviso",
      category: "UTILITY",
      language: "pt_BR",
      processedParams: { body: {} },
    };
    await sendZproTemplate(client, "5511999990000", payload);
    expect(calls[0]).toEqual({
      number: "5511999990000",
      templateName: "aviso",
      languageCode: "pt_BR",
      components: undefined,
    });
  });
});
