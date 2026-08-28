// src/modules/zpro/contact-auth.ts
// Z-PRO's own contact-authorization gate (docs/contact-auth.md) — the same feature Chatwoot has,
// adapted for a channel with no Contact table and no bigint contact id to key anything on.
//
// Reuses the fully channel-agnostic core as-is: checkContactAuthorization/classifyAuthorizationResponse
// (contact-auth/check.ts), readContactAuthConfig (contact-auth/settings.ts), singleFlight
// (contact-auth/state.ts), contactAuthFlowEvent/contactAuthNoteText (contact-auth/service.ts). What
// it does NOT reuse is authorizeContact itself — that function's identity read and single-flight key
// are hard-typed to Chatwoot's `Contact.id`, and its grant-reuse half (`mode: "once"`) is keyed the
// same way.
//
// SCOPING DECISION: `mode: "once"` (issue #189's stored-grant reuse) is NOT ported here. It is
// documented as a pure OPTIMIZATION over the correct default (`perMessage`: ask on every message) —
// never required for correctness, since asking fresh is always the safe answer. Chatwoot's own
// grants.ts needed "four review rounds" to get its race handling right (in-memory refusedAt/
// unconfirmed bookkeeping, a per-contact serialized mutation queue, an asymmetric
// drop-on-refusal-under-every-mode rule) for a PERFORMANCE optimization; duplicating that against a
// phone-number-keyed table for a channel that does not yet exercise it carries real risk for no
// correctness gain. A Z-PRO agent configured for `mode: "once"` today gets `perMessage` behavior
// instead — asks every time, same fail-closed guarantee, only ever costs an extra endpoint call,
// never a wrong verdict. The `ZproContactAuthGrant` table/migration already exists for when this is
// picked up. Tracked as a follow-up in docs/zpro.md.

import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import {
  type CheckDeps,
  type ContactAuthVerdict,
  channelSlug,
  checkContactAuthorization,
  underSignal,
} from "@/modules/contact-auth/check";
import type { ContactAuthConfig } from "@/modules/contact-auth/settings";
import { singleFlight } from "@/modules/contact-auth/state";
import {
  type InjectableCredential,
  resolveInjectableCredentialEntry,
} from "@/modules/vault/injectable";
import { isNonInjectableSecret } from "@/modules/vault/secret-types";

export interface ZproContactAuthResult extends ContactAuthVerdict {
  // True when this call did not ask the endpoint itself — coalesced into a concurrent call's
  // request (single-flight). Mirrors ContactAuthResult.shared (contact-auth/service.ts).
  shared: boolean;
}

export interface AuthorizeZproContactParams {
  tenantId: bigint;
  agentId: bigint;
  // ev.contactNumber / ev.contactName from the normalized webhook event. null phone is theoretical
  // for a WhatsApp ticket, but never assumed.
  contactNumber: string | null;
  contactName: string | null;
  // The operator's own id for this contact, Z-PRO's analog of Chatwoot's native `identifier` field:
  // no such native field exists here, so this reads `contactExtraInfo.identifier` — an operator-set
  // custom attribute (via set_custom_attribute or the Z-PRO panel), the strongest key available.
  identifier: string | null;
  // Z-PRO's own ticket id, for the request body's `conversation.id` — display-only to the endpoint.
  ticketId: number;
  channelType: string | null;
  // The triggering message's text; null on a proactive nudge. Only forwarded (capped, in `message`)
  // when includeMessageText is on — check.ts's buildAuthorizationRequest already enforces that.
  messageText: string | null;
  // Single-flight scope: the triggering message's id under includeMessageText (the verdict is a
  // function of the text), the caller's own name otherwise ("nudge"). See check.ts's ContactIdentity.
  requestKey: string;
  cfg: ContactAuthConfig;
  base?: PrismaClient;
  fetchImpl?: typeof fetch;
  assertSafe?: CheckDeps["assertSafe"];
  resolveCredential?: typeof resolveInjectableCredentialEntry;
}

function trimmed(v: string | null): string | null {
  return v?.trim() ? v.trim() : null;
}

export async function authorizeZproContact(
  params: AuthorizeZproContactParams,
): Promise<ZproContactAuthResult> {
  const { tenantId, agentId, cfg } = params;
  const phone = trimmed(params.contactNumber);
  const identifier = trimmed(params.identifier);
  // A Z-PRO contact has no Chatwoot-shaped `Contact` row to be missing — the WhatsApp number IS the
  // identity — so the only way to reach here with nothing to ask about is a payload that carried no
  // usable number at all (theoretical for WhatsApp) and no operator identifier either.
  if (!phone && !identifier) {
    return { outcome: "no_identity", shared: false, reason: "no_identifiers" };
  }
  // Single-flight scoped to the identity being asked about — the Z-PRO analog of
  // contactAuthFlightKey's `${tenantId}:${agentId}:${contactDbId}:${request}` (state.ts), just keyed
  // by phone/identifier instead of a bigint id. `singleFlight` itself is unmodified: it only ever
  // took a plain string key.
  const key = `zpro:${tenantId}:${agentId}:${phone ?? identifier}:${params.requestKey}`;
  const { verdict, shared } = await singleFlight(
    key,
    async (): Promise<ContactAuthVerdict> => {
      if (!cfg.url) return { outcome: "error", reason: "not_configured" };
      // One budget for credential resolution + the check itself, same reasoning as
      // contact-auth/service.ts's authorizeContact: a managed-OAuth credential refreshes its token
      // over the network, under the SAME ceiling the HTTP check gets, or a gate configured for one
      // second could hold the webhook for the credential resolver's own timeout on top.
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
      try {
        let credential: InjectableCredential | null = null;
        if (cfg.credentialRef) {
          let timedOut = false;
          try {
            const resolve =
              params.resolveCredential ?? resolveInjectableCredentialEntry;
            credential = await underSignal(
              resolve(params.base ?? basePrisma, tenantId, cfg.credentialRef),
              ctrl.signal,
            );
          } catch (err) {
            timedOut = ctrl.signal.aborted;
            logger.warn(
              "zpro contact-auth: credential resolution failed (agent=%s): %s",
              String(agentId),
              err instanceof Error ? err.message : String(err),
            );
          }
          if (timedOut) return { outcome: "error", reason: "timeout" };
          if (!credential) {
            return { outcome: "error", reason: "credential_unavailable" };
          }
          if (isNonInjectableSecret(credential.kind)) {
            logger.warn(
              "zpro contact-auth: credential kind %s is never injected into an outbound request (agent=%s)",
              String(credential.kind),
              String(agentId),
            );
            return { outcome: "error", reason: "credential_not_injectable" };
          }
        }
        return await checkContactAuthorization(
          cfg,
          {
            phone,
            name: trimmed(params.contactName),
            email: null,
            identifier,
            chatwootContactId: null,
            conversationId: params.ticketId,
            inboxId: null,
            channel: channelSlug(params.channelType),
            messageText: params.messageText,
          },
          credential,
          {
            fetchImpl: params.fetchImpl,
            assertSafe: params.assertSafe,
            signal: ctrl.signal,
          },
        );
      } finally {
        clearTimeout(timer);
      }
    },
  );
  return { ...verdict, shared };
}
