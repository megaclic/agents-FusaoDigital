// tests/modules/zpro/parse.test.ts
// Pure unit tests for resolveZproInstanceCandidate — the disambiguation guard added after finding
// that whatsappId is unique only PER TENANT (@@unique([tenantId, whatsappId])): two independent
// Z-PRO installs across different tenants can report the same whatsappId, and picking the wrong
// candidate would silently mirror one tenant's conversations into another's.

import { describe, expect, test } from "bun:test";
import {
  extractMedia,
  extractQuotedText,
  parseContactTags,
  parseMediaKey,
  resolveZproInstanceCandidate,
  withQuotedPrefix,
} from "@/modules/zpro/parse";
import type { ZproMsgTop } from "@/modules/zpro/types";

interface Candidate {
  id: number;
  apiId: string;
}

describe("resolveZproInstanceCandidate", () => {
  test("zero candidates → null", () => {
    expect(resolveZproInstanceCandidate<Candidate>([], undefined)).toBeNull();
  });

  test("a single candidate is returned as-is, even without an apikey (the common case)", () => {
    const only = { id: 1, apiId: "abc" };
    expect(resolveZproInstanceCandidate([only], undefined)).toBe(only);
  });

  test("multiple candidates + no apikey → null (never guess)", () => {
    const candidates = [
      { id: 1, apiId: "abc" },
      { id: 2, apiId: "def" },
    ];
    expect(resolveZproInstanceCandidate(candidates, undefined)).toBeNull();
  });

  test("multiple candidates + apikey matching exactly one apiId → that candidate", () => {
    const match = { id: 2, apiId: "def" };
    const candidates = [{ id: 1, apiId: "abc" }, match];
    expect(resolveZproInstanceCandidate(candidates, "def")).toBe(match);
  });

  test("multiple candidates + apikey matching NONE → null (never guess)", () => {
    const candidates = [
      { id: 1, apiId: "abc" },
      { id: 2, apiId: "def" },
    ];
    expect(resolveZproInstanceCandidate(candidates, "ghi")).toBeNull();
  });

  test("multiple candidates + apikey matching MORE than one (duplicate apiId) → null (never guess)", () => {
    const candidates = [
      { id: 1, apiId: "abc" },
      { id: 2, apiId: "abc" },
    ];
    expect(resolveZproInstanceCandidate(candidates, "abc")).toBeNull();
  });
});

// contact.tags's shape is unconfirmed (no example response in the vendor's Postman collection) —
// parseContactTags must tolerate every plausible shape without throwing, per mirror.ts's use of it
// on every inbound webhook.
describe("parseContactTags", () => {
  test("not an array → []", () => {
    expect(parseContactTags(undefined)).toEqual([]);
    expect(parseContactTags(null)).toEqual([]);
    expect(parseContactTags("vip")).toEqual([]);
    expect(parseContactTags({ id: 1, name: "vip" })).toEqual([]);
  });

  test("array of {id,name} objects", () => {
    expect(
      parseContactTags([
        { id: 1, name: "vip" },
        { id: 2, name: "lead" },
      ]),
    ).toEqual([
      { id: 1, name: "vip" },
      { id: 2, name: "lead" },
    ]);
  });

  test("array of bare positive integer ids → name null", () => {
    expect(parseContactTags([1, 2])).toEqual([
      { id: 1, name: null },
      { id: 2, name: null },
    ]);
  });

  test("array of bare non-empty strings → id null", () => {
    expect(parseContactTags(["vip", "lead"])).toEqual([
      { id: null, name: "vip" },
      { id: null, name: "lead" },
    ]);
  });

  test("drops entries with neither a usable id nor name, never throws", () => {
    expect(
      parseContactTags([
        { id: 1, name: "vip" },
        { foo: "bar" },
        0,
        -1,
        "",
        "  ",
        null,
        undefined,
        true,
      ]),
    ).toEqual([{ id: 1, name: "vip" }]);
  });

  test("trims whitespace on string names", () => {
    expect(parseContactTags(["  vip  "])).toEqual([{ id: null, name: "vip" }]);
    expect(parseContactTags([{ id: 1, name: "  vip  " }])).toEqual([
      { id: 1, name: "vip" },
    ]);
  });

  test("mixed shapes in the same array", () => {
    expect(parseContactTags([1, "vip", { id: 2, name: "lead" }])).toEqual([
      { id: 1, name: null },
      { id: null, name: "vip" },
      { id: 2, name: "lead" },
    ]);
  });
});

// audioMessage.mediaKey's wire shape is UNCONFIRMED and already changed once: the WhatsApp
// protocol calls for base64, but a live capture (2026-08-14) showed a plain array-like object
// instead — a Buffer/Uint8Array serialized without its `.toJSON()`, losing its array-ness over the
// wire. parseMediaKey must tolerate both (plus a real byte array) without throwing, since
// media-crypto.ts's decryptWhatsappMedia is the security-relevant step everything else feeds.
describe("parseMediaKey", () => {
  const key32 = Array.from({ length: 32 }, (_, i) => i);
  const key32Base64 = Buffer.from(key32).toString("base64");

  test("a plain base64 string passes through unchanged", () => {
    expect(parseMediaKey(key32Base64)).toBe(key32Base64);
  });

  test("a real byte array is base64-encoded", () => {
    expect(parseMediaKey(key32)).toBe(key32Base64);
  });

  test('an array-like object ({"0":n,...,"31":n}) is base64-encoded', () => {
    const arrayLike = Object.fromEntries(key32.map((n, i) => [String(i), n]));
    expect(parseMediaKey(arrayLike)).toBe(key32Base64);
  });

  test("undefined, null, empty string, or a non-numeric object → undefined, never throws", () => {
    expect(parseMediaKey(undefined)).toBeUndefined();
    expect(parseMediaKey(null)).toBeUndefined();
    expect(parseMediaKey("")).toBeUndefined();
    expect(parseMediaKey("   ")).toBeUndefined();
    expect(parseMediaKey({})).toBeUndefined();
    expect(parseMediaKey({ type: "Buffer" })).toBeUndefined();
    expect(parseMediaKey(42)).toBeUndefined();
    expect(parseMediaKey(["not", "numbers"])).toBeUndefined();
  });
});

// contextInfo (WhatsApp "reply to a specific message") location CONFIRMED live (2026-08-14, 12
// real captures via the ngrok inspector): it sits at the top-level data.contextInfo, a SIBLING of
// `message` — a reply to plain text stays typed "conversation" on this wire format, never
// upgraded to "extendedTextMessage" the way vanilla Baileys does. The extendedTextMessage/
// media-type contextInfo candidates are still checked as defensive fallbacks (never observed, but
// harmless) — must degrade to undefined on any mismatch rather than throwing, per
// parseMediaKey/parseContactTags's precedent.
function baseMsg(overrides: Partial<ZproMsgTop> = {}): ZproMsgTop {
  return {
    event: "messages.upsert",
    instance: "test",
    fromMe: false,
    id: "msg1",
    body: null,
    type: "conversation",
    timestamp: Date.now(),
    from: "5511999999999",
    read: false,
    ack: 1,
    ...overrides,
  };
}

describe("extractQuotedText", () => {
  test("extendedTextMessage.contextInfo.quotedMessage.conversation → the quoted text", () => {
    const msg = baseMsg({
      data: {
        message: {
          extendedTextMessage: {
            text: "vc entendeu?",
            contextInfo: {
              stanzaId: "ABC123",
              quotedMessage: {
                conversation: "por enquanto nao. vamos aguardar",
              },
            },
          },
        },
      },
    });
    expect(extractQuotedText(msg)).toBe("por enquanto nao. vamos aguardar");
  });

  test("top-level data.contextInfo (sibling of message) is also checked", () => {
    const msg = baseMsg({
      data: {
        contextInfo: {
          quotedMessage: { conversation: "mensagem original" },
        },
        message: { conversation: "vc entendeu?" },
      },
    });
    expect(extractQuotedText(msg)).toBe("mensagem original");
  });

  // Shape of a real captured reply (ngrok inspector, 2026-08-14): a plain-text message stays typed
  // "conversation" (never upgraded to "extendedTextMessage"), and contextInfo carries the usual
  // envelope siblings (mentionedJid/groupMentions/statusAttributions/ephemeralSettingTimestamp/
  // disappearingMode) alongside stanzaId/participant/quotedMessage — the extra fields must not
  // confuse extraction.
  test("real captured shape: conversation type + full contextInfo envelope", () => {
    const msg = baseMsg({
      type: "conversation",
      data: {
        message: { conversation: "não, estou falando sobre isso." },
        contextInfo: {
          mentionedJid: [],
          groupMentions: [],
          statusAttributions: [],
          stanzaId: "3EB0E4627F18062569E3A8",
          participant: "217192838725774@lid",
          quotedMessage: {
            conversation: "O que ter à mão na consulta\n- Fotos do acidente;",
          },
          ephemeralSettingTimestamp: {
            low: 1786560929,
            high: 0,
            unsigned: false,
          },
          disappearingMode: { initiator: 0, trigger: 1, initiatedByMe: false },
        },
      },
    });
    expect(extractQuotedText(msg)).toBe(
      "O que ter à mão na consulta - Fotos do acidente;",
    );
  });

  test("quoted media with no caption degrades to a type marker instead of disappearing", () => {
    const msg = baseMsg({
      data: {
        message: {
          extendedTextMessage: {
            text: "e essa?",
            contextInfo: { quotedMessage: { audioMessage: { url: "x" } } },
          },
        },
      },
    });
    expect(extractQuotedText(msg)).toBe("<mensagem de áudio>");
  });

  test("collapses whitespace and truncates to 200 chars", () => {
    const long = "a".repeat(250);
    const msg = baseMsg({
      data: {
        message: {
          extendedTextMessage: {
            text: "oi",
            contextInfo: {
              quotedMessage: {
                conversation: `  linha 1\n\n  linha  2  ${long}`,
              },
            },
          },
        },
      },
    });
    const result = extractQuotedText(msg);
    expect(result?.length).toBe(200);
    expect(result?.startsWith("linha 1 linha 2 aaa")).toBe(true);
  });

  test("no contextInfo → undefined", () => {
    const msg = baseMsg({ data: { message: { conversation: "oi" } } });
    expect(extractQuotedText(msg)).toBeUndefined();
  });

  test("contextInfo present but no quotedMessage → undefined, never throws", () => {
    const msg = baseMsg({
      data: {
        message: {
          extendedTextMessage: { text: "oi", contextInfo: { stanzaId: "x" } },
        },
      },
    });
    expect(extractQuotedText(msg)).toBeUndefined();
  });

  test("malformed contextInfo shapes degrade to undefined instead of throwing", () => {
    expect(
      extractQuotedText(
        baseMsg({
          data: {
            message: { extendedTextMessage: { contextInfo: "not an object" } },
          },
        }),
      ),
    ).toBeUndefined();
    expect(
      extractQuotedText(
        baseMsg({
          data: {
            message: {
              extendedTextMessage: {
                contextInfo: { quotedMessage: "also not an object" },
              },
            },
          },
        }),
      ),
    ).toBeUndefined();
    expect(extractQuotedText(baseMsg({ data: undefined }))).toBeUndefined();
  });
});

describe("withQuotedPrefix", () => {
  test("no quotedText → body unchanged", () => {
    expect(withQuotedPrefix("oi", undefined)).toBe("oi");
    expect(withQuotedPrefix("oi", null)).toBe("oi");
  });

  test("quotedText + body → prefixed with the reply marker", () => {
    expect(withQuotedPrefix("vc entendeu?", "mensagem original")).toBe(
      '<em resposta a: "mensagem original">\nvc entendeu?',
    );
  });

  test("quotedText + empty body → marker-only line, not dropped", () => {
    expect(withQuotedPrefix("", "mensagem original")).toBe(
      '<em resposta a: "mensagem original">',
    );
  });
});

describe("extractMedia mediaKey normalization", () => {
  const key32 = Array.from({ length: 32 }, (_, i) => i + 1);
  const key32Base64 = Buffer.from(key32).toString("base64");
  const arrayLikeKey = Object.fromEntries(key32.map((n, i) => [String(i), n]));

  test("audioMessage: array-like mediaKey normalizes to base64 and tags mediaType 'audio'", () => {
    const result = extractMedia({
      audioMessage: {
        url: "https://mmg.whatsapp.net/x.enc",
        mediaKey: arrayLikeKey,
      },
    });
    expect(result.mediaKey).toBe(key32Base64);
    expect(result.mediaType).toBe("audio");
  });

  test("imageMessage: a real base64 string mediaKey passes through, mediaType 'image'", () => {
    const result = extractMedia({
      imageMessage: {
        url: "https://mmg.whatsapp.net/y.enc",
        mediaKey: key32Base64,
      },
    });
    expect(result.mediaKey).toBe(key32Base64);
    expect(result.mediaType).toBe("image");
  });

  test("no mediaKey on the message → mediaKey undefined, mediaType still set", () => {
    const result = extractMedia({
      documentMessage: { url: "https://mmg.whatsapp.net/z.enc" },
    });
    expect(result.mediaKey).toBeUndefined();
    expect(result.mediaType).toBe("document");
  });
});
