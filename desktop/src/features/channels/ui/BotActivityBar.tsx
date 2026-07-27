import * as React from "react";
import { Loader2 } from "lucide-react";

import { useAgentTranscript } from "@/features/agents/ui/useObserverEvents";
import type { UserProfileLookup } from "@/features/profile/lib/identity";
import type { ManagedAgent } from "@/shared/api/types";
import { useFeatureEnabled } from "@/shared/features";
import { cn } from "@/shared/lib/cn";
import { useNow } from "@/shared/lib/useNow";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import { Shimmer } from "@/shared/ui/Shimmer";
import { UserAvatar } from "@/shared/ui/UserAvatar";
import { ComposerLiveActivityFeed } from "./ComposerLiveActivityFeed";
import { deriveActivityPillLabel } from "./composerLiveActivity";

export type BotActivityAgent = Pick<ManagedAgent, "pubkey" | "name" | "status">;

type BotActivityBarProps = {
  agents: BotActivityAgent[];
  channelId?: string | null;
  onOpenAgentSession: (pubkey: string, channelId?: string | null) => void;
  openAgentSessionPubkey: string | null;
  profiles?: UserProfileLookup;
  workingBotPubkeys: string[];
};

const HOVER_OPEN_DELAY_MS = 150;
const HOVER_CLOSE_DELAY_MS = 180;
/** Re-render cadence for the pill label's staleness check. */
const PILL_LABEL_TICK_MS = 5_000;
/** Shown when no fresh action headline exists (see deriveActivityPillLabel). */
const GENERIC_WORKING_LABEL = "Working…";

/** Hover-intent popover state shared by every activity pill. */
function useHoverPopover() {
  const [open, setOpen] = React.useState(false);
  const hoverTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const clearHoverTimer = React.useCallback(() => {
    if (hoverTimerRef.current !== null) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }, []);

  const openWithDelay = React.useCallback(() => {
    clearHoverTimer();
    hoverTimerRef.current = setTimeout(() => {
      setOpen(true);
    }, HOVER_OPEN_DELAY_MS);
  }, [clearHoverTimer]);

  const closeWithDelay = React.useCallback(() => {
    clearHoverTimer();
    hoverTimerRef.current = setTimeout(() => {
      setOpen(false);
    }, HOVER_CLOSE_DELAY_MS);
  }, [clearHoverTimer]);

  React.useEffect(() => {
    return () => clearHoverTimer();
  }, [clearHoverTimer]);

  return { clearHoverTimer, closeWithDelay, open, openWithDelay, setOpen };
}

/**
 * One working agent's status pill: avatar + the agent's latest action summary
 * (decaying to a generic working label when activity goes quiet). Hovering
 * shows the agent's live activity feed as the popover surface itself — flat,
 * no inset box, no tab strip — while clicking the pill opens the agent's full
 * runtime in the auxiliary panel. With the `composerLiveActivity` preview
 * flag off, the hover popover keeps the legacy "View activity" item instead.
 */
function BotActivityAgentPill({
  agent,
  avatarUrl,
  channelId,
  liveActivityEnabled,
  onOpenAgentSession,
  openAgentSessionPubkey,
  profiles,
}: {
  agent: BotActivityAgent;
  avatarUrl: string | null;
  channelId: string | null;
  liveActivityEnabled: boolean;
  onOpenAgentSession: (pubkey: string, channelId?: string | null) => void;
  openAgentSessionPubkey: string | null;
  profiles?: UserProfileLookup;
}) {
  const { clearHoverTimer, closeWithDelay, open, openWithDelay, setOpen } =
    useHoverPopover();
  const transcript = useAgentTranscript(true, agent.pubkey);
  const now = useNow(PILL_LABEL_TICK_MS);
  const headline = React.useMemo(
    () => deriveActivityPillLabel({ channelId, now, transcript }),
    [channelId, now, transcript],
  );
  const label = headline ?? GENERIC_WORKING_LABEL;
  const isSessionOpen =
    openAgentSessionPubkey?.toLowerCase() === agent.pubkey.toLowerCase();

  const openSession = () => {
    clearHoverTimer();
    setOpen(false);
    onOpenAgentSession(agent.pubkey, channelId);
  };

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <button
          aria-label={`${agent.name} is working. View activity.`}
          className="inline-flex h-7 min-w-0 max-w-30 items-center gap-1.5 rounded-full border border-border/60 bg-background px-2 text-xs font-semibold leading-none text-muted-foreground shadow-xs transition-colors hover:border-primary/30 hover:bg-primary/5 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:border-primary/40 data-[state=open]:bg-primary/10 data-[state=open]:text-primary"
          data-testid="bot-activity-composer-trigger"
          onBlur={closeWithDelay}
          onClick={(event) => {
            // The popover is a hover preview; clicking goes straight to the
            // agent's runtime in the aux panel. preventDefault stops Radix's
            // composed trigger toggle from fighting over the popover state.
            event.preventDefault();
            openSession();
          }}
          onFocus={() => setOpen(true)}
          onMouseEnter={openWithDelay}
          onMouseLeave={closeWithDelay}
          type="button"
        >
          <UserAvatar
            avatarUrl={avatarUrl}
            className="!h-[18px] !w-[18px] shrink-0 text-3xs"
            displayName={agent.name}
            size="xs"
          />
          <span className="min-w-0 flex-1 overflow-hidden">
            <Shimmer className="block truncate">{label}</Shimmer>
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className={cn(
          liveActivityEnabled ? "w-80 overflow-hidden p-0" : "w-64 p-1",
        )}
        onMouseEnter={clearHoverTimer}
        onMouseLeave={closeWithDelay}
        onOpenAutoFocus={(event) => event.preventDefault()}
        side="top"
        sideOffset={8}
      >
        {liveActivityEnabled ? (
          <ComposerLiveActivityFeed
            agent={agent}
            channelId={channelId}
            className="h-48 rounded-[inherit]"
            onOpenAgentSession={() => openSession()}
            profiles={profiles}
          />
        ) : (
          <button
            className={cn(
              "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors",
              isSessionOpen
                ? "bg-primary/10 text-primary"
                : "text-foreground hover:bg-accent hover:text-accent-foreground",
            )}
            data-testid={`bot-activity-composer-item-${agent.pubkey}`}
            onClick={openSession}
            type="button"
          >
            <UserAvatar
              avatarUrl={avatarUrl}
              className="shrink-0"
              displayName={agent.name}
              size="sm"
            />
            <span className="min-w-0 flex-1 truncate">{agent.name}</span>
            <span className="shrink-0 whitespace-nowrap text-xs font-medium opacity-80">
              View activity
            </span>
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground/70" />
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Composer status strip for working agents: one pill per working agent, each
 * owning its hover popover. Pills shrink and truncate their labels when
 * several agents work at once so the strip never wraps the fixed-height row.
 */
export function BotActivityComposerAction({
  agents,
  channelId = null,
  onOpenAgentSession,
  openAgentSessionPubkey,
  profiles,
  workingBotPubkeys,
}: BotActivityBarProps) {
  const liveActivityEnabled = useFeatureEnabled("composerLiveActivity");

  const workingAgents = React.useMemo(() => {
    const workingSet = new Set(
      workingBotPubkeys.map((pubkey) => pubkey.toLowerCase()),
    );

    return agents.filter((agent) => workingSet.has(agent.pubkey.toLowerCase()));
  }, [agents, workingBotPubkeys]);

  if (workingAgents.length === 0) {
    return null;
  }

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-visible">
      {workingAgents.map((agent) => (
        <BotActivityAgentPill
          agent={agent}
          avatarUrl={profiles?.[agent.pubkey.toLowerCase()]?.avatarUrl ?? null}
          channelId={channelId}
          key={agent.pubkey}
          liveActivityEnabled={liveActivityEnabled}
          onOpenAgentSession={onOpenAgentSession}
          openAgentSessionPubkey={openAgentSessionPubkey}
          profiles={profiles}
        />
      ))}
    </div>
  );
}
