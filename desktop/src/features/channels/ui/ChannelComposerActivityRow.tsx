import { useChannelWorkingAgentPubkeys } from "@/features/agents/agentWorkingSignal";
import {
  BotActivityComposerAction,
  type BotActivityAgent,
} from "@/features/channels/ui/BotActivityBar";
import { TypingIndicatorRow } from "@/features/messages/ui/TypingIndicatorRow";
import type { UserProfileLookup } from "@/features/profile/lib/identity";
import type { Channel } from "@/shared/api/types";

/**
 * Status strip anchored directly below the message composer: the inline
 * "agents working" trigger plus the typing indicator.
 *
 * The row has a FIXED height (not min-h): it must not grow when the inline
 * bot-activity button (h-7) mounts, or the bottom-anchored composer above it
 * visibly bumps up. 34px (h-8.5) = 28px button + 6px bottom padding, the
 * row's rendered height while a trigger is present. Guarded by the "composer
 * does not shift when the activity row mounts and clears" e2e test.
 */
export function ChannelComposerActivityRow({
  agents,
  channel,
  currentPubkey,
  onOpenAgentSession,
  openAgentSessionPubkey,
  profiles,
  typingPubkeys,
}: {
  agents: BotActivityAgent[];
  channel: Channel | null;
  currentPubkey?: string;
  onOpenAgentSession: (pubkey: string, channelId?: string | null) => void;
  openAgentSessionPubkey: string | null;
  profiles?: UserProfileLookup;
  typingPubkeys: string[];
}) {
  // Unified working set for the composer bar: observer-derived turns primary,
  // bot typing fallback (both folded together by agentWorkingSignal). This is
  // what makes the bar show for an agent whose observer stream is live but
  // whose typing signal never arrives — and vice versa.
  const workingBotPubkeys = useChannelWorkingAgentPubkeys(channel?.id ?? null);

  return (
    <div
      className="h-8.5 overflow-visible bg-background px-5 pb-1.5 pt-0"
      data-testid="channel-composer-activity-row"
    >
      <div className="flex h-full w-full items-center gap-2 overflow-visible">
        {workingBotPubkeys.length > 0 ? (
          <div className="flex min-w-0 flex-1 overflow-visible">
            <BotActivityComposerAction
              agents={agents}
              channelId={channel?.id ?? null}
              onOpenAgentSession={onOpenAgentSession}
              openAgentSessionPubkey={openAgentSessionPubkey}
              profiles={profiles}
              variant="inline"
              workingBotPubkeys={workingBotPubkeys}
            />
          </div>
        ) : null}
        {typingPubkeys.length > 0 ? (
          <TypingIndicatorRow
            channel={channel}
            className="min-w-0 flex-1 py-0 pl-[calc(0.75rem+1px)] pr-0 sm:pl-[calc(1rem+1px)]"
            currentPubkey={currentPubkey}
            profiles={profiles}
            typingPubkeys={typingPubkeys}
          />
        ) : null}
      </div>
    </div>
  );
}
