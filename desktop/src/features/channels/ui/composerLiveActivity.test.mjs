import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveActivityPillLabel,
  deriveLastLiveAt,
} from "./composerLiveActivity.ts";

const CHANNEL = "channel-1";
const OTHER_CHANNEL = "channel-2";

const NOW = Date.parse("2026-07-23T00:01:00.000Z");

/** Thought item: spine, headlined by its title. */
const thought = (title, timestamp, channelId = CHANNEL) => ({
  id: `thought-${title}-${timestamp}`,
  type: "thought",
  renderClass: "thought",
  title,
  text: "",
  timestamp,
  channelId,
});

/** Metadata item: meaningful but NOT spine — recedes when real work exists. */
const metadata = (title, timestamp, channelId = CHANNEL) => ({
  id: `metadata-${title}-${timestamp}`,
  type: "metadata",
  renderClass: "raw-rail",
  title,
  sections: [],
  timestamp,
  acpSource: "prompt_context",
  channelId,
});

const secondsBeforeNow = (seconds) =>
  new Date(NOW - seconds * 1000).toISOString();

test("deriveActivityPillLabel returns the newest fresh headline, no rotation", () => {
  const label = deriveActivityPillLabel({
    channelId: CHANNEL,
    now: NOW,
    transcript: [
      thought("Reading files", secondsBeforeNow(8)),
      thought("Editing ChannelPane", secondsBeforeNow(2)),
    ],
  });
  assert.equal(label, "Editing ChannelPane");
});

test("deriveActivityPillLabel decays to null once the newest headline is stale", () => {
  const label = deriveActivityPillLabel({
    channelId: CHANNEL,
    now: NOW,
    transcript: [thought("Editing ChannelPane", secondsBeforeNow(30))],
  });
  assert.equal(label, null);
});

test("deriveActivityPillLabel honors a custom staleness window", () => {
  const transcript = [thought("Editing ChannelPane", secondsBeforeNow(30))];
  const label = deriveActivityPillLabel({
    channelId: CHANNEL,
    now: NOW,
    staleAfterMs: 60_000,
    transcript,
  });
  assert.equal(label, "Editing ChannelPane");
});

test("deriveActivityPillLabel ignores other-channel items", () => {
  const label = deriveActivityPillLabel({
    channelId: CHANNEL,
    now: NOW,
    transcript: [
      thought("In-channel work", secondsBeforeNow(10)),
      thought("Other-channel work", secondsBeforeNow(1), OTHER_CHANNEL),
    ],
  });
  assert.equal(label, "In-channel work");
});

test("deriveActivityPillLabel lets spine work headline over fresher metadata reads", () => {
  const label = deriveActivityPillLabel({
    channelId: CHANNEL,
    now: NOW,
    transcript: [
      thought("Real work", secondsBeforeNow(10)),
      metadata("Prompt context", secondsBeforeNow(1)),
    ],
  });
  assert.equal(label, "Real work");
});

test("deriveActivityPillLabel falls back to metadata when no spine items exist", () => {
  const label = deriveActivityPillLabel({
    channelId: CHANNEL,
    now: NOW,
    transcript: [metadata("Prompt context", secondsBeforeNow(5))],
  });
  assert.equal(label, "Prompt context");
});

test("deriveActivityPillLabel returns null for an empty transcript", () => {
  const label = deriveActivityPillLabel({
    channelId: CHANNEL,
    now: NOW,
    transcript: [],
  });
  assert.equal(label, null);
});

test("deriveLastLiveAt prefers the newest channel-scoped transcript item", () => {
  const lastLiveAt = deriveLastLiveAt({
    activeTurns: [],
    archivedEvents: [],
    channelId: CHANNEL,
    transcript: [
      { channelId: CHANNEL, timestamp: "2026-07-23T00:00:01.000Z" },
      { channelId: OTHER_CHANNEL, timestamp: "2026-07-23T00:00:09.000Z" },
      { channelId: CHANNEL, timestamp: "2026-07-23T00:00:05.000Z" },
    ],
  });
  assert.equal(lastLiveAt, Date.parse("2026-07-23T00:00:05.000Z"));
});

test("deriveLastLiveAt sees archived content the panel renders", () => {
  // Regression: archived rows are visible in the preview even when the live
  // transcript window is empty — the pill must not say "No activity yet".
  const lastLiveAt = deriveLastLiveAt({
    activeTurns: [],
    archivedEvents: [{ timestamp: "2026-07-20T10:00:00.000Z" }],
    channelId: CHANNEL,
    transcript: [],
  });
  assert.equal(lastLiveAt, Date.parse("2026-07-20T10:00:00.000Z"));
});

test("deriveLastLiveAt takes the newest across live, archive, and turn anchor", () => {
  const lastLiveAt = deriveLastLiveAt({
    activeTurns: [
      { anchorAt: Date.parse("2026-07-23T00:00:30.000Z"), channelId: CHANNEL },
    ],
    archivedEvents: [{ timestamp: "2026-07-23T00:00:10.000Z" }],
    channelId: CHANNEL,
    transcript: [{ channelId: CHANNEL, timestamp: "2026-07-23T00:00:20.000Z" }],
  });
  assert.equal(lastLiveAt, Date.parse("2026-07-23T00:00:30.000Z"));
});

test("deriveLastLiveAt falls back to the active-turn anchor with no items", () => {
  const anchorAt = Date.parse("2026-07-23T00:01:00.000Z");
  const lastLiveAt = deriveLastLiveAt({
    activeTurns: [{ anchorAt, channelId: CHANNEL }],
    archivedEvents: [],
    channelId: CHANNEL,
    transcript: [],
  });
  assert.equal(lastLiveAt, anchorAt);
});

test("deriveLastLiveAt ignores other-channel turns and returns null when idle", () => {
  const lastLiveAt = deriveLastLiveAt({
    activeTurns: [{ anchorAt: 1, channelId: OTHER_CHANNEL }],
    archivedEvents: [],
    channelId: CHANNEL,
    transcript: [],
  });
  assert.equal(lastLiveAt, null);
});
