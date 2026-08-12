// src/modules/zpro/tts.ts
// Respostas em áudio (TTS) no canal Z-PRO — reaproveita o registry de providers genérico
// (src/modules/tts/{providers,service,settings}.ts, o mesmo do Chatwoot) sem nenhum acoplamento
// Chatwoot. Duas peças específicas do Z-PRO aqui:
//   - sendZproVoiceReply: decide entre ZproClient.sendVoice (nota de voz nativa, exige Ogg/Opus) e
//     sendBase64 (arquivo genérico) conforme o container escolhido por pickTtsFormat — mesma
//     distinção que o Chatwoot documenta pro Instagram (mp3/wav não viram PTT), aplicada aqui porque
//     o Z-PRO só tem canal WhatsApp e o único provider que não emite Ogg/Opus é o openrouter (mp3).
//   - buildSetVoicePreferenceTool: equivalente Z-PRO da tool nativa set_voice_preference
//     (src/graph/tools/native.ts), mas grava em ZproConversation.voiceReply em vez de
//     Contact.voiceReply — Z-PRO não tem uma tabela Contact.

import type { StructuredToolInterface } from "@langchain/core/tools";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { PrismaClient } from "@/../generated/prisma/client";
import { runScopedOn } from "@/lib/tenancy";
import type { TtsResult } from "@/modules/tts/providers";
import type { ZproClient } from "./client";
import { sysCtx } from "./ctx";
import type { NormalizedZproEvent } from "./types";

// OPEN-VALIDATION: ZproClient.sendVoice's own comment documents its `audio` param as "base64,
// ogg/opus" — untested against a live Z-PRO instance with anything else, hence the sendBase64
// fallback below for any other container (openai/elevenlabs always resolve to ogg_opus on a
// WhatsApp-only channel; only openrouter's mp3-only output reaches the fallback branch).
export async function sendZproVoiceReply(
  client: ZproClient,
  event: NormalizedZproEvent,
  result: TtsResult,
): Promise<void> {
  const base64 = Buffer.from(result.audio).toString("base64");
  if (result.mime === "audio/ogg") {
    await client.sendVoice(event.contactNumber, base64, {
      externalKey: `voice-${event.messageId}-${Date.now()}`,
    });
    return;
  }
  // Not a native voice note (see the OPEN-VALIDATION note above): send as a generic file
  // attachment instead of mis-tagging bytes ZproClient.sendVoice never claimed to support.
  await client.sendBase64(
    event.contactNumber,
    base64,
    result.mime,
    result.fileName,
    undefined,
    { validateNumber: false },
  );
}

// Records the customer's audio-vs-text reply preference on ZproConversation.voiceReply (TTS
// "preference" mode). A DB write, not a Z-PRO API call — mirrors Chatwoot's set_voice_preference
// (src/graph/tools/native.ts), adapted since Z-PRO has no Contact table.
export function buildSetVoicePreferenceTool(params: {
  tenantId: bigint;
  base: PrismaClient;
  conversationId: bigint;
  currentVoiceReply: boolean | null;
}): StructuredToolInterface {
  const { tenantId, base, conversationId, currentVoiceReply } = params;
  return tool(
    async ({ preference }: { preference: "audio" | "text" | "default" }) => {
      // "default" clears the preference (null) → the reply mirrors the customer's own format
      // (text→text, audio→audio), exactly how shouldReplyWithAudio treats null.
      const value =
        preference === "audio" ? true : preference === "text" ? false : null;
      await runScopedOn(base, sysCtx(tenantId), (db) =>
        db.zproConversation.updateMany({
          where: { id: conversationId },
          data: { voiceReply: value },
        }),
      );
      return preference === "default"
        ? "Voice preference reset: replies now mirror what the customer sends (audio→audio, text→text)."
        : `Voice preference saved: the customer prefers ${preference} replies.`;
    },
    {
      name: "set_voice_preference",
      description: `Record whether THIS customer prefers replies as audio (voice notes), as text, or to RESET to the default (mirror what the customer sent — audio gets audio, text gets text). Call when the customer states a preference (e.g. 'me manda áudio', 'prefiro texto', 'tanto faz'/'pode ser dos dois jeitos' → default). The customer's current stored preference is shown in \`<current_preference>\` below ("not set" ⇒ replies mirror the customer).\n\n<current_preference>${
        currentVoiceReply === true
          ? "audio"
          : currentVoiceReply === false
            ? "text"
            : "not set"
      }</current_preference>`,
      schema: z.object({
        preference: z
          .enum(["audio", "text", "default"])
          .describe(
            "audio = wants voice notes; text = wants text; default = reset to mirroring the customer's own format",
          ),
      }),
    },
  );
}
