import type { PlaygroundCapabilities } from "./PlaygroundChat";
import { PlaygroundChat } from "./PlaygroundChat";
import type { ChannelBinding } from "./types";
import type { usePlaygroundChat } from "./usePlaygroundChat";

// Chat with the agent directly, with no Chatwoot round trip — same model + prompt + knowledge/tools
// as production (native conversation tools excluded; utility tools included). The chat state is
// owned by AgentEditorPage (via usePlaygroundChat) so it survives tab switches and is shared with
// the floating popup; this tab is a thin view over PlaygroundChat.
export function PlaygroundTab({
  chat,
  agentId,
  missingConfig,
  capabilities,
  toolsDirty,
  channelBinding,
}: {
  chat: ReturnType<typeof usePlaygroundChat>;
  agentId: string;
  missingConfig: string[];
  capabilities: PlaygroundCapabilities;
  toolsDirty: boolean;
  channelBinding: ChannelBinding;
}) {
  return (
    <PlaygroundChat
      chat={chat}
      agentId={agentId}
      missingConfig={missingConfig}
      capabilities={capabilities}
      toolsDirty={toolsDirty}
      channelBinding={channelBinding}
    />
  );
}
