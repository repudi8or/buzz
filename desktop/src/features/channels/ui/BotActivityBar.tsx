import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

import {
  getAgentTranscript,
  subscribeAgentObserverStore,
} from "@/features/agents/observerRelayStore";
import { useAgentTranscript } from "@/features/agents/ui/useObserverEvents";
import type { UserProfileLookup } from "@/features/profile/lib/identity";
import type { ManagedAgent } from "@/shared/api/types";
import { cn } from "@/shared/lib/cn";
import { useNow } from "@/shared/lib/useNow";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import { Shimmer } from "@/shared/ui/Shimmer";
import { UserAvatar } from "@/shared/ui/UserAvatar";
import { ComposerLiveActivityFeed } from "./ComposerLiveActivityFeed";
import {
  deriveActivityPillLabel,
  deriveAgentActivityOrder,
} from "./composerLiveActivity";

export type BotActivityAgent = Pick<ManagedAgent, "pubkey" | "name" | "status">;

type BotActivityBarProps = {
  agents: BotActivityAgent[];
  channelId?: string | null;
  onOpenAgentSession: (pubkey: string, channelId?: string | null) => void;
  profiles?: UserProfileLookup;
  workingBotPubkeys: string[];
};

const HOVER_OPEN_DELAY_MS = 150;
const HOVER_CLOSE_DELAY_MS = 180;
/**
 * Re-render cadence for the pill label's staleness check. One second so the
 * decay to the generic label lands promptly after the stale window elapses.
 */
const PILL_LABEL_TICK_MS = 1_000;
/** Ticker key for the generic label so decay/recovery animate as one swap. */
const GENERIC_LABEL_ID = "generic-working";
/**
 * Perceptual duration shared by the pill reorder spring and the opacity dip
 * keyframes so the fade lands together with the layout switch.
 */
const PILL_REORDER_DURATION_S = 0.9;

// Stable subscribe reference for useSyncExternalStore (same pattern as
// useObserverEvents).
const subscribeToObserverStore = (onStoreChange: () => void) =>
  subscribeAgentObserverStore(onStoreChange);

/**
 * Strip-level hover popover state: ONE active pill and ONE timer for the
 * whole composer strip.
 *
 * Hover state used to live per pill, which raced N independent open/close
 * timers against each other: traveling pill A → pill B opened B's card at
 * +150ms while A's close fired at +180ms (brief double-open), and a cursor
 * that clipped A's open card on the way cancelled A's close entirely,
 * leaving the card stuck. Centralizing means at most one card can ever be
 * open and pill-to-pill travel is a single deterministic switch.
 */
type StripHoverPopover = {
  /** Pill key (lowercased pubkey) whose hover card is open, or null. */
  activePubkey: string | null;
  /** Cancel any pending open/close without touching the current card. */
  cancelPending: () => void;
  /** Close immediately (click-through to the session, Radix dismiss). */
  closeNow: () => void;
  /** Pointer entered a pill trigger. */
  enterTrigger: (pubkey: string) => void;
  /** Open a pill's card immediately (keyboard focus). */
  openNow: (pubkey: string) => void;
  /** Pointer left a trigger or the open card: close after the grace delay. */
  scheduleClose: () => void;
};

/**
 * Edge-fade state for the horizontally scrollable pill strip: which sides
 * currently have pills clipped out of view. Tracks the scroller's scroll
 * position plus size changes of both the scroller (container narrows —
 * thread panel resize) and its content wrapper (pills entering, leaving, or
 * relabeling to a different width), so the fades appear and disappear
 * without a re-render triggering event.
 */
function useStripOverflowFades(
  scrollerRef: React.RefObject<HTMLDivElement | null>,
) {
  const [fades, setFades] = React.useState({ end: false, start: false });

  const updateFades = React.useCallback(() => {
    const node = scrollerRef.current;
    if (node === null) {
      return;
    }
    // 1px slack absorbs sub-pixel rounding in scrollWidth/clientWidth.
    const start = node.scrollLeft > 1;
    const end = node.scrollLeft + node.clientWidth < node.scrollWidth - 1;
    setFades((current) =>
      current.start === start && current.end === end ? current : { end, start },
    );
  }, [scrollerRef]);

  React.useEffect(() => {
    const node = scrollerRef.current;
    if (node === null) {
      return;
    }
    updateFades();
    const observer = new ResizeObserver(updateFades);
    observer.observe(node);
    // The content wrapper is the scroller's only child; observing it catches
    // overflow changes that don't touch the scroller's own box.
    const content = node.firstElementChild;
    if (content !== null) {
      observer.observe(content);
    }
    return () => observer.disconnect();
  }, [scrollerRef, updateFades]);

  return { fades, updateFades };
}

function useStripHoverPopover(): StripHoverPopover {
  const [activePubkey, setActivePubkey] = React.useState<string | null>(null);
  // Ref mirror so pointer handlers can branch on open-vs-closed synchronously.
  const activeRef = React.useRef<string | null>(null);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelPending = React.useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const setActive = React.useCallback(
    (pubkey: string | null) => {
      cancelPending();
      activeRef.current = pubkey;
      setActivePubkey(pubkey);
    },
    [cancelPending],
  );

  const enterTrigger = React.useCallback(
    (pubkey: string) => {
      // With a card up (or in its close grace period), reaching another pill
      // switches the card right away — re-arming the intent delay here is
      // what raced the per-pill timers. From a fully closed strip, keep the
      // hover-intent delay; the single timer means the pending target simply
      // follows the cursor.
      if (activeRef.current !== null) {
        setActive(pubkey);
        return;
      }
      cancelPending();
      timerRef.current = setTimeout(() => {
        setActive(pubkey);
      }, HOVER_OPEN_DELAY_MS);
    },
    [cancelPending, setActive],
  );

  const scheduleClose = React.useCallback(() => {
    cancelPending();
    if (activeRef.current === null) {
      // Nothing open — leaving just abandons the pending hover intent.
      return;
    }
    timerRef.current = setTimeout(() => {
      setActive(null);
    }, HOVER_CLOSE_DELAY_MS);
  }, [cancelPending, setActive]);

  const openNow = React.useCallback(
    (pubkey: string) => setActive(pubkey),
    [setActive],
  );

  const closeNow = React.useCallback(() => setActive(null), [setActive]);

  React.useEffect(() => {
    return () => cancelPending();
  }, [cancelPending]);

  return {
    activePubkey,
    cancelPending,
    closeNow,
    enterTrigger,
    openNow,
    scheduleClose,
  };
}

/**
 * One working agent's status pill: avatar + the agent's latest action summary
 * (decaying to a generic working label when activity goes quiet). Label
 * updates play as a clipped ticker — the new text pushes the old text up and
 * out — deferred until the pill's slot settles when a reorder is in flight.
 * Hovering shows the agent's live activity feed as the popover surface
 * itself — flat, no inset box, no tab strip — while clicking the pill opens
 * the agent's full runtime in the auxiliary panel.
 *
 * Only observer-backed agents reach this pill: typing-fallback-only agents
 * are diverted into the combined typing indicator group by
 * ChannelComposerActivityRow before the strip renders.
 */
function BotActivityAgentPill({
  agent,
  avatarUrl,
  channelId,
  holdLabelSwap,
  hover,
  onOpenAgentSession,
  pinWidth,
  profiles,
}: {
  agent: BotActivityAgent;
  avatarUrl: string | null;
  channelId: string | null;
  /** Defer label swaps while the pill's slot is mid layout animation. */
  holdLabelSwap: boolean;
  /** Strip-level hover popover state shared by every pill. */
  hover: StripHoverPopover;
  onOpenAgentSession: (pubkey: string, channelId?: string | null) => void;
  /** Freeze the pill's rendered width (a hover card is showing). */
  pinWidth: boolean;
  profiles?: UserProfileLookup;
}) {
  const pillKey = agent.pubkey.toLowerCase();
  const open = hover.activePubkey === pillKey;
  const shouldReduceMotion = useReducedMotion();
  const transcript = useAgentTranscript(true, agent.pubkey);
  const now = useNow(PILL_LABEL_TICK_MS);
  const headline = React.useMemo(
    () => deriveActivityPillLabel({ channelId, now, transcript }),
    [channelId, now, transcript],
  );
  const activeId = headline?.id ?? GENERIC_LABEL_ID;
  // No fresh action headline (see deriveActivityPillLabel) — decay to the
  // agent-named generic working label.
  const activeLabel = headline?.label ?? `${agent.name} is working…`;
  // The rendered label lags the derived one while the pill is moving: the
  // push-up ticker plays after the slot settles (or immediately when idle).
  // Keyed by transcript item id, not label text — a NEW action swaps, while
  // streamed chunks growing the same item update text in place.
  const [display, setDisplay] = React.useState({
    id: activeId,
    label: activeLabel,
  });
  React.useEffect(() => {
    if (holdLabelSwap) {
      return;
    }
    setDisplay((current) =>
      current.id === activeId && current.label === activeLabel
        ? current
        : { id: activeId, label: activeLabel },
    );
  }, [holdLabelSwap, activeId, activeLabel]);

  // While a hover card is showing, the pill must not resize: label swaps
  // keep animating, but a longer/shorter label truncating inside a FROZEN
  // width can no longer shift the neighboring pills under the cursor. The
  // width is measured once when the hold starts and dropped on release.
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const [pinnedWidth, setPinnedWidth] = React.useState<number | null>(null);
  React.useLayoutEffect(() => {
    if (!pinWidth) {
      setPinnedWidth(null);
      return;
    }
    const node = triggerRef.current;
    if (node !== null) {
      setPinnedWidth(node.getBoundingClientRect().width);
    }
  }, [pinWidth]);

  const openSession = () => {
    hover.closeNow();
    onOpenAgentSession(agent.pubkey, channelId);
  };

  const pillContent = (
    <>
      <UserAvatar
        avatarUrl={avatarUrl}
        className="!h-5 !w-5 shrink-0 text-3xs"
        displayName={agent.name}
        size="xs"
      />
      <span className="relative block h-3.5 min-w-0 flex-1 overflow-hidden">
        <AnimatePresence initial={false} mode="popLayout">
          <motion.span
            animate={{ y: 0 }}
            className="flex h-full items-center"
            exit={{ y: "-110%" }}
            initial={shouldReduceMotion ? false : { y: "110%" }}
            key={display.id}
            transition={
              shouldReduceMotion
                ? { duration: 0 }
                : { type: "tween", duration: 0.28, ease: "easeOut" }
            }
          >
            <Shimmer className="block min-w-0 truncate">
              {display.label}
            </Shimmer>
          </motion.span>
        </AnimatePresence>
      </span>
    </>
  );

  return (
    <Popover
      onOpenChange={(nextOpen) => {
        // Radix only drives closes here (escape / outside dismiss) — trigger
        // clicks are preventDefault'ed and hover opens are controlled.
        if (!nextOpen) {
          hover.closeNow();
        }
      }}
      open={open}
    >
      <PopoverTrigger asChild>
        <button
          aria-label={`${agent.name} is working. View activity.`}
          className="inline-flex h-7 min-w-0 max-w-50 items-center gap-1.5 rounded-full border border-border/60 bg-background pl-0.75 pr-2 text-xs font-semibold leading-none text-muted-foreground shadow-xs transition-colors hover:border-primary/30 hover:bg-primary/5 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:border-primary/40 data-[state=open]:bg-primary/10 data-[state=open]:text-primary"
          data-testid="bot-activity-composer-trigger"
          onBlur={hover.scheduleClose}
          onClick={(event) => {
            // The popover is a hover preview; clicking goes straight to the
            // agent's runtime in the aux panel. preventDefault stops Radix's
            // composed trigger toggle from fighting over the popover state.
            event.preventDefault();
            openSession();
          }}
          onFocus={(event) => {
            // Keyboard focus only (:focus-visible). Plain focus also lands
            // here when Radix returns focus to the trigger as the card
            // closes — opening on that re-opened the card in a loop.
            if (event.currentTarget.matches(":focus-visible")) {
              hover.openNow(pillKey);
            }
          }}
          onMouseEnter={() => hover.enterTrigger(pillKey)}
          onMouseLeave={hover.scheduleClose}
          ref={triggerRef}
          style={pinnedWidth === null ? undefined : { width: pinnedWidth }}
          type="button"
        >
          {pillContent}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 overflow-hidden p-0"
        onCloseAutoFocus={(event) => {
          // A hover preview must not yank focus back to the trigger on
          // close: the trigger's focus handler would re-open the card.
          event.preventDefault();
        }}
        onMouseEnter={hover.cancelPending}
        onMouseLeave={hover.scheduleClose}
        onOpenAutoFocus={(event) => event.preventDefault()}
        side="top"
        sideOffset={8}
      >
        <ComposerLiveActivityFeed
          agent={agent}
          channelId={channelId}
          className="h-48 rounded-[inherit]"
          onOpenAgentSession={() => openSession()}
          profiles={profiles}
        />
      </PopoverContent>
    </Popover>
  );
}

/**
 * Layout slot for one pill in the composer strip. While a pill travels to a
 * new slot (layout animation) its opacity dips and recovers via keyframes
 * that run for the same duration as the slot spring, so the fade and the
 * move finish together and reorders read as a shuffle instead of a hard
 * swap. Enter/exit use the same scale+fade treatment. While a hover card is
 * showing (`freezeLayout`), layout animation is disabled entirely so nothing
 * can slide under the cursor.
 */
function AnimatedPillSlot({
  children,
  freezeLayout,
  shouldReduceMotion,
  shrinkToFit,
}: {
  /** Render prop so the pill can defer label swaps while its slot moves. */
  children: (isMoving: boolean) => React.ReactNode;
  /** Disable slot layout animation while a hover card is showing. */
  freezeLayout: boolean;
  shouldReduceMotion: boolean;
  /**
   * Lone pill: shrink with the container (label ellipsizes) instead of
   * overflowing into scroll — an edge fade over a single pill reads as a
   * cut-off bug, not an affordance.
   */
  shrinkToFit: boolean;
}) {
  const [isMoving, setIsMoving] = React.useState(false);

  // Freezing mid-flight cuts the layout animation short, and
  // onLayoutAnimationComplete never fires for a cancelled run — clear the
  // moving flag here so the pill's label-swap hold can't get stuck.
  React.useEffect(() => {
    if (freezeLayout) {
      setIsMoving(false);
    }
  }, [freezeLayout]);

  return (
    <motion.div
      animate={{ opacity: isMoving ? [1, 0.35, 1] : 1, scale: 1 }}
      // With several pills, shrink-0 keeps each at its natural
      // (label-truncated) width so a strip that outgrows a narrow container
      // scrolls — with the edge fade signalling the pills off view —
      // instead of compressing every pill into an unreadable sliver. A lone
      // pill instead shrinks to fit (min-w-0) so it never scrolls.
      className={cn("flex", shrinkToFit ? "min-w-0" : "shrink-0")}
      exit={{ opacity: 0, scale: 0.9 }}
      initial={shouldReduceMotion ? false : { opacity: 0, scale: 0.9 }}
      layout={!shouldReduceMotion && !freezeLayout}
      onLayoutAnimationComplete={() => setIsMoving(false)}
      onLayoutAnimationStart={() => setIsMoving(true)}
      transition={
        shouldReduceMotion
          ? { duration: 0 }
          : {
              type: "spring",
              duration: PILL_REORDER_DURATION_S,
              bounce: 0.15,
              opacity: {
                type: "tween",
                duration: PILL_REORDER_DURATION_S,
                ease: "linear",
              },
            }
      }
    >
      {children(isMoving)}
    </motion.div>
  );
}

/**
 * Composer status strip for working agents: one pill per working agent,
 * sharing one strip-level hover popover (at most one card open). Pills are
 * ordered most-recently-active first (left-most) and animate to their new
 * slot as the order changes — except while the cursor is over the bar or a
 * hover card is showing, when order, membership, layout animation, and pill
 * widths are all frozen so nothing can move out from under (or slide under)
 * the cursor. Each pill truncates its label at its own max width. A lone
 * pill shrinks with a narrow container (its label ellipsizes) so it always
 * fits; when SEVERAL pills outgrow a narrow container (thread panel
 * toolbars especially) the strip scrolls horizontally — scrollbar hidden,
 * with edge gradient fades signalling the pills off view — instead of
 * compressing every pill into an unreadable sliver or wrapping the
 * fixed-height row.
 */
export function BotActivityComposerAction({
  agents,
  channelId = null,
  onOpenAgentSession,
  profiles,
  workingBotPubkeys,
}: BotActivityBarProps) {
  const shouldReduceMotion = useReducedMotion();
  const hover = useStripHoverPopover();
  // The freeze engages as soon as the cursor is anywhere over the bar — not
  // only once a card opens — so pills can't move (or resize) under a cursor
  // that is still traveling toward one. It also holds while a card is open
  // with the cursor off the bar (over the card itself, or during the close
  // grace period).
  const [barHovered, setBarHovered] = React.useState(false);
  const holdActive = barHovered || hover.activePubkey !== null;

  const scrollerRef = React.useRef<HTMLDivElement | null>(null);
  const { fades, updateFades } = useStripOverflowFades(scrollerRef);

  const workingAgents = React.useMemo(() => {
    const workingSet = new Set(
      workingBotPubkeys.map((pubkey) => pubkey.toLowerCase()),
    );

    return agents.filter((agent) => workingSet.has(agent.pubkey.toLowerCase()));
  }, [agents, workingBotPubkeys]);

  // Most-recent-first pill order. The snapshot is a joined string so
  // useSyncExternalStore only re-renders this strip when the ORDER actually
  // changes, not on every observer store write.
  const getOrderSnapshot = React.useCallback(
    () =>
      deriveAgentActivityOrder({
        channelId,
        getTranscript: (pubkey) => getAgentTranscript(pubkey, true),
        pubkeys: workingAgents.map((agent) => agent.pubkey.toLowerCase()),
      }).join(","),
    [channelId, workingAgents],
  );
  const orderKey = React.useSyncExternalStore(
    subscribeToObserverStore,
    getOrderSnapshot,
  );
  const liveOrderedAgents = React.useMemo(() => {
    const byPubkey = new Map(
      workingAgents.map((agent) => [agent.pubkey.toLowerCase(), agent]),
    );
    return orderKey === ""
      ? []
      : orderKey.split(",").flatMap((pubkey) => byPubkey.get(pubkey) ?? []);
  }, [orderKey, workingAgents]);

  // While the hold is active, the strip must not move under the cursor:
  // pill order AND membership are frozen at their last hold-free values.
  // Reorders queue up behind the hold and apply when it releases; an agent
  // that finishes mid-hold keeps its pill until then. Without this, a
  // reorder slides the hovered pill away (firing a spurious mouseleave that
  // closes the card) or slides a different pill under the cursor (opening
  // the wrong one).
  //
  // The queued order is adopted in an effect (a commit AFTER the release
  // render) on purpose: the release render still shows the frozen order but
  // re-enables slot layout animation, so when the live order lands next
  // commit the pills ANIMATE from their frozen slots into the new layout
  // instead of snapping.
  const [orderedAgents, setOrderedAgents] =
    React.useState<BotActivityAgent[]>(liveOrderedAgents);
  React.useEffect(() => {
    if (holdActive) {
      return;
    }
    setOrderedAgents((current) =>
      current.length === liveOrderedAgents.length &&
      current.every((agent, index) => agent === liveOrderedAgents[index])
        ? current
        : liveOrderedAgents,
    );
  }, [holdActive, liveOrderedAgents]);

  if (orderedAgents.length === 0) {
    return null;
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover-only hold — keyboard focus drives the same hold via the pill triggers.
    <div
      className="relative min-w-0 flex-1"
      data-testid="bot-activity-strip"
      onMouseEnter={() => setBarHovered(true)}
      onMouseLeave={() => setBarHovered(false)}
    >
      {/* layoutScroll keeps the slot layout animations correct while the
          strip is scrolled — motion measures positions relative to the
          scroll offset instead of jumping. The negative-margin/padding pair
          gives focus rings and pill shadows room inside the clip box
          without changing the row's height. */}
      <motion.div
        className="-my-1 flex items-center overflow-x-auto overscroll-x-contain py-1 scrollbar-none [&::-webkit-scrollbar]:hidden"
        data-testid="bot-activity-strip-scroller"
        layoutScroll
        onScroll={updateFades}
        ref={scrollerRef}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <AnimatePresence initial={false}>
            {orderedAgents.map((agent) => (
              <AnimatedPillSlot
                freezeLayout={holdActive}
                key={agent.pubkey}
                shouldReduceMotion={Boolean(shouldReduceMotion)}
                shrinkToFit={orderedAgents.length === 1}
              >
                {(isMoving) => (
                  <BotActivityAgentPill
                    agent={agent}
                    avatarUrl={
                      profiles?.[agent.pubkey.toLowerCase()]?.avatarUrl ?? null
                    }
                    channelId={channelId}
                    holdLabelSwap={isMoving}
                    hover={hover}
                    onOpenAgentSession={onOpenAgentSession}
                    pinWidth={holdActive}
                    profiles={profiles}
                  />
                )}
              </AnimatedPillSlot>
            ))}
          </AnimatePresence>
        </div>
      </motion.div>
      {/* Edge fades: obvious "more pills off view" affordance. Rendered only
          for a side that actually has clipped content, so they never dim a
          fully visible strip. */}
      {fades.start ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 z-10 w-8 bg-linear-to-r from-background via-background/60 to-transparent"
          data-testid="bot-activity-strip-fade-start"
        />
      ) : null}
      {fades.end ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 z-10 w-8 bg-linear-to-l from-background via-background/60 to-transparent"
          data-testid="bot-activity-strip-fade-end"
        />
      ) : null}
    </div>
  );
}
