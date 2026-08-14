// src/modules/zpro/split.ts
// Split + typing pacing (humanized delivery) para o canal Z-PRO — reaproveita os helpers PUROS do
// registry compartilhado (src/modules/split/service.ts's splitReply/typingDelayMs/readSplitConfig/
// SplitConfig, o mesmo do Chatwoot), mas não reaproveita deliverReply em si: ele é hard-coded pro
// ChatwootClient (client.sendMessage/toggleTyping). deliverZproReply abaixo é o equivalente Z-PRO,
// usando ZproClient.sendText — SEM presence própria: o indicador "digitando..." é responsabilidade
// de messages.ts's startTypingHeartbeat, ligado pelo ÚNICO caller real (runtime.ts's
// runLoadedZproTurn) por TODO o turno, incluindo esta entrega. Um sendPresence por balão aqui
// (versão anterior) tinha o MESMO bug do sinal único no início do turno: um sinal isolado antes de
// um sleep de até 8s (SplitConfig.maxDelayMs) piscava e sumia antes do WhatsApp receber a próxima
// atualização — ver docs/zpro.md's "Split + typing pacing".

import { type FlowContext, withFlowStage } from "@/modules/flowlog/service";
import {
  type SplitConfig,
  splitReply,
  typingDelayMs,
} from "@/modules/split/service";
import type { ZproClient } from "./client";
import type { NormalizedZproEvent } from "./types";

const realSleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

// Sends the reply, split + paced when enabled. The sleep is injectable for tests. Mirrors
// src/modules/split/service.ts's deliverReply's split/pacing shape, just over ZproClient — but NOT
// its per-chunk typing toggle (see module header: the caller's heartbeat already covers this).
export async function deliverZproReply(
  client: ZproClient,
  event: NormalizedZproEvent,
  reply: string,
  cfg: SplitConfig,
  sleep: (ms: number) => Promise<void> = realSleep,
  flow?: FlowContext,
): Promise<number> {
  return withFlowStage(
    flow,
    "split",
    { detail: { enabled: cfg.enabled } },
    async () => {
      if (!cfg.enabled) {
        await client.sendText(event.contactNumber, reply, {
          externalKey: `reply-${event.messageId}-0-${Date.now()}`,
          validateNumber: false,
        });
        return 1;
      }
      const chunks = splitReply(reply, cfg);
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i] as string;
        await sleep(typingDelayMs(chunk, cfg));
        await client.sendText(event.contactNumber, chunk, {
          externalKey: `reply-${event.messageId}-${i}-${Date.now()}`,
          validateNumber: false,
        });
      }
      return chunks.length;
    },
  );
}
