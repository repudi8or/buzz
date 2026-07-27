import * as React from "react";

import {
  getAgentWorkingState,
  subscribeAgentWorkingSignal,
  useChannelWorkingAgentPubkeys,
} from "@/features/agents/agentWorkingSignal";
import {
  BotActivityComposerAction,
  type BotActivityAgent,
} from "@/features/channels/ui/BotActivityBar";
import { TypingIndicatorRow } from "@/features/messages/ui/TypingIndicatorRow";
import type { UserProfileLookup } from "@/features/profile/lib/identity";
import type { Channel } from "@/shared/api/types";

/**
 * Status strip anchored directly below the message composer: the working
 * agent pills plus the typing indicator, rendered as slot siblings inside
 * ONE strip (BotActivityComposerAction) so both share the scroller, edge
 * fades, and layout/enter/exit animations.
 *
 * The working set splits by signal source: observer-backed agents get the
 * interactive activity pills, while typing-fallback-only agents (no observer
 * turn — nothing to hover or open) merge with the human typers into ONE
 * combined typing indicator group ("X and Y are typing…") with an
 * overlapping avatar set.
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
  profiles,
  typingPubkeys,
}: {
  agents: BotActivityAgent[];
  channel: Channel | null;
  currentPubkey?: string;
  onOpenAgentSession: (pubkey: string, channelId?: string | null) => void;
  profiles?: UserProfileLookup;
  typingPubkeys: string[];
}) {
  const channelId = channel?.id ?? null;
  // Unified working set for the composer bar: observer-derived turns primary,
  // bot typing fallback (both folded together by agentWorkingSignal). This is
  // what makes the bar show for an agent whose observer stream is live but
  // whose typing signal never arrives — and vice versa.
  const workingBotPubkeys = useChannelWorkingAgentPubkeys(channelId);

  // Typing-fallback-only pubkeys (channel-scoped working source "typing").
  // Snapshot is a joined string so useSyncExternalStore only re-renders when
  // the partition actually changes, not on every signal write.
  const getAgentTypingSnapshot = React.useCallback(
    () =>
      workingBotPubkeys
        .filter(
          (pubkey) =>
            getAgentWorkingState(pubkey, channelId).source === "typing",
        )
        .join(","),
    [channelId, workingBotPubkeys],
  );
  const agentTypingKey = React.useSyncExternalStore(
    subscribeAgentWorkingSignal,
    getAgentTypingSnapshot,
  );
  const agentTypingPubkeys = React.useMemo(
    () => (agentTypingKey === "" ? [] : agentTypingKey.split(",")),
    [agentTypingKey],
  );
  const observerWorkingPubkeys = React.useMemo(() => {
    const typingSet = new Set(agentTypingPubkeys);
    return workingBotPubkeys.filter((pubkey) => !typingSet.has(pubkey));
  }, [agentTypingPubkeys, workingBotPubkeys]);

  // Humans and typing-fallback agents share one indicator group.
  const combinedTypingPubkeys = React.useMemo(
    () => [...typingPubkeys, ...agentTypingPubkeys],
    [agentTypingPubkeys, typingPubkeys],
  );

  // The channel-agent roster carries names for agents that have no profile
  // entry (e.g. relay-roster-only agents); overlay them so the typing label
  // never falls back to a truncated pubkey.
  const typingProfiles = React.useMemo(() => {
    if (agentTypingPubkeys.length === 0 || agents.length === 0) {
      return profiles;
    }
    const merged: UserProfileLookup = { ...profiles };
    for (const agent of agents) {
      const key = agent.pubkey.toLowerCase();
      merged[key] = {
        ...merged[key],
        displayName: merged[key]?.displayName || agent.name,
        avatarUrl: merged[key]?.avatarUrl ?? null,
        nip05Handle: merged[key]?.nip05Handle ?? null,
        isAgent: true,
      };
    }
    return merged;
  }, [agentTypingPubkeys.length, agents, profiles]);

  return (
    <div
      className="h-8.5 overflow-visible bg-background px-5 pb-1.5 pt-0"
      data-testid="channel-composer-activity-row"
    >
      <div className="flex h-full w-full items-center overflow-visible">
        {/* One strip hosts both groups: working pills plus the typing group
            as the strip's trailing slot sibling, so they share the scroller,
            edge fades, and layout/enter/exit animations. When the row gets
            tight the strip scrolls horizontally (edge fades signal clipped
            items) rather than compressing. */}
        {observerWorkingPubkeys.length > 0 ||
        combinedTypingPubkeys.length > 0 ? (
          <BotActivityComposerAction
            agents={agents}
            channelId={channelId}
            onOpenAgentSession={onOpenAgentSession}
            profiles={profiles}
            typingIndicator={
              combinedTypingPubkeys.length > 0 ? (
                <TypingIndicatorRow
                  channel={channel}
                  // The strip's slot owns spacing and the typing-only inset;
                  // zero the base paddings and let the row shrink so the
                  // lone-item slot can ellipsize the label.
                  className="min-w-0 shrink px-0 py-0 sm:px-0"
                  currentPubkey={currentPubkey}
                  profiles={typingProfiles}
                  typingPubkeys={combinedTypingPubkeys}
                />
              ) : null
            }
            workingBotPubkeys={observerWorkingPubkeys}
          />
        ) : null}
      </div>
    </div>
  );
}
