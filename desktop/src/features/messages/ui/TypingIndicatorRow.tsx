import * as React from "react";

import {
  resolveUserLabel,
  type UserProfileLookup,
} from "@/features/profile/lib/identity";
import { ProfileAvatar } from "@/features/profile/ui/ProfileAvatar";
import type { Channel } from "@/shared/api/types";
import { cn } from "@/shared/lib/cn";
import { Shimmer } from "@/shared/ui/Shimmer";
import { truncatePubkey } from "@/shared/lib/pubkey";

type TypingIndicatorRowProps = {
  channel: Channel | null;
  className?: string;
  currentPubkey?: string;
  /** Extra classes for the "… is typing" label (e.g. weight overrides). */
  labelClassName?: string;
  profiles?: UserProfileLookup;
  typingPubkeys: string[];
};

function resolveFallbackName(channel: Channel | null, pubkey: string) {
  if (channel?.channelType !== "dm") {
    return null;
  }

  const participantIndex = channel.participantPubkeys.findIndex(
    (candidate) => candidate.toLowerCase() === pubkey.toLowerCase(),
  );

  if (participantIndex < 0) {
    return null;
  }

  return channel.participants[participantIndex] ?? null;
}

function formatTypingLabel(names: string[]) {
  if (names.length === 1) {
    return `${names[0]} is typing...`;
  }

  if (names.length === 2) {
    return `${names[0]} and ${names[1]} are typing...`;
  }

  if (names.length === 3) {
    return `${names[0]}, ${names[1]}, and ${names[2]} are typing...`;
  }

  return `${names[0]}, ${names[1]}, and ${names.length - 2} more are typing...`;
}

export function TypingIndicatorRow({
  channel,
  className,
  currentPubkey,
  labelClassName,
  profiles,
  typingPubkeys,
}: TypingIndicatorRowProps) {
  const labels = React.useMemo(
    () =>
      typingPubkeys.map((pubkey) =>
        resolveUserLabel({
          pubkey,
          currentPubkey,
          fallbackName: resolveFallbackName(channel, pubkey),
          profiles,
          preferResolvedSelfLabel: true,
        }),
      ),
    [channel, currentPubkey, profiles, typingPubkeys],
  );

  return (
    <div
      aria-live="polite"
      className={cn("shrink-0 bg-transparent px-4 py-2 sm:px-6", className)}
      {...(labels.length > 0
        ? { "data-testid": "message-typing-indicator" }
        : {})}
    >
      {labels.length > 0 && (
        <div className="flex min-w-0 w-full items-center gap-2">
          <div className="flex shrink-0 items-center">
            {typingPubkeys.map((pubkey, index) => {
              const profile = profiles?.[pubkey.toLowerCase()];
              const label = labels[index] ?? truncatePubkey(pubkey);
              return (
                <div
                  key={pubkey}
                  className={cn(
                    "relative h-5 w-5 shrink-0 rounded-lg ring-1 ring-background",
                    index > 0 && "-ml-1.5",
                  )}
                  data-testid="message-typing-avatar"
                >
                  <ProfileAvatar
                    avatarUrl={profile?.avatarUrl ?? null}
                    label={label}
                    className="h-5 w-5 text-3xs"
                    iconClassName="h-4 w-4"
                  />
                </div>
              );
            })}
          </div>
          <p
            className={cn(
              "min-w-0 translate-y-px truncate text-xs font-medium leading-4 text-muted-foreground",
              labelClassName,
            )}
            data-testid="message-typing-indicator-label"
          >
            <Shimmer>{formatTypingLabel(labels)}</Shimmer>
          </p>
        </div>
      )}
    </div>
  );
}
