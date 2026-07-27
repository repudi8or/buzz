import {
  getActivityHeadline,
  isMeaningfulItem,
  isSpineItem,
} from "@/features/agents/ui/agentSessionTranscriptPresentation";
import type { TranscriptItem } from "@/features/agents/ui/agentSessionTypes";

/**
 * How long the latest action headline stays on a working agent's composer
 * pill before the label decays to the generic working state.
 */
export const ACTIVITY_PILL_STALE_MS = 15_000;

/**
 * Latest fresh action headline for a working agent's composer pill.
 *
 * Channel-scoped, two-tier scan (spine items headline over metadata reads,
 * mirroring the session transcript's noise gate), newest wins. Returns null
 * when there is no headline or the newest one is older than `staleAfterMs`;
 * the pill then falls back to its generic "Working…" label. Deliberately no
 * rotation through recent actions: one headline, then decay.
 */
export function deriveActivityPillLabel({
  channelId,
  now,
  staleAfterMs = ACTIVITY_PILL_STALE_MS,
  transcript,
}: {
  channelId: string | null;
  now: number;
  staleAfterMs?: number;
  transcript: readonly TranscriptItem[];
}): string | null {
  const scoped = channelId
    ? transcript.filter((item) => item.channelId === channelId)
    : transcript;
  const passFilter = scoped.some(isSpineItem) ? isSpineItem : isMeaningfulItem;

  for (let index = scoped.length - 1; index >= 0; index -= 1) {
    const item = scoped[index];
    if (!item || !passFilter(item)) {
      continue;
    }
    const headline = getActivityHeadline(item);
    if (!headline) {
      continue;
    }
    const millis = Date.parse(item.timestamp);
    if (!Number.isNaN(millis) && now - millis > staleAfterMs) {
      return null;
    }
    return headline;
  }

  return null;
}

/**
 * Latest activity timestamp (ms) for the composer preview's "Last live" pill.
 *
 * Reads the same sources the preview panel renders — the live transcript
 * window AND the channel-scoped archive — so the pill can never claim
 * "No activity yet" while archived rows are visible underneath. Falls back
 * to the active-turn anchor when a turn is running but no items exist yet.
 */
export function deriveLastLiveAt({
  activeTurns,
  archivedEvents,
  channelId,
  transcript,
}: {
  activeTurns: readonly { anchorAt: number; channelId: string }[];
  archivedEvents: readonly { timestamp: string }[];
  channelId: string | null;
  transcript: readonly {
    channelId?: string | null;
    timestamp: string;
  }[];
}): number | null {
  let latest: number | null = null;
  const record = (timestamp: number) => {
    if (latest === null || timestamp > latest) {
      latest = timestamp;
    }
  };

  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const item = transcript[index];
    if (!item || (channelId && item.channelId !== channelId)) {
      continue;
    }
    const millis = Date.parse(item.timestamp);
    if (!Number.isNaN(millis)) {
      record(millis);
      break;
    }
  }

  // Archived events are already channel-scoped by the store, sorted ascending.
  for (let index = archivedEvents.length - 1; index >= 0; index -= 1) {
    const event = archivedEvents[index];
    if (!event) {
      continue;
    }
    const millis = Date.parse(event.timestamp);
    if (!Number.isNaN(millis)) {
      record(millis);
      break;
    }
  }

  const channelTurn = channelId
    ? activeTurns.find((turn) => turn.channelId === channelId)
    : activeTurns[0];
  if (channelTurn) {
    record(channelTurn.anchorAt);
  }

  return latest;
}
