import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveActivityPillLabel,
  deriveAgentActivityOrder,
  deriveLastLiveAt,
} from "./composerLiveActivity.ts";

const CHANNEL = "channel-1";
const OTHER_CHANNEL = "channel-2";

const NOW = Date.parse("2026-07-23T00:01:00.000Z");
const NOW_ISO = new Date(NOW).toISOString();

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

/** Lifecycle meta-frame (usage tick / commands): spine, but never a headline. */
const lifecycleMeta = (acpSource, timestamp, channelId = CHANNEL) => ({
  id: `lifecycle-${acpSource}-${timestamp}`,
  type: "lifecycle",
  renderClass: "status",
  title: acpSource === "usage_update" ? "Usage" : "Commands",
  text: "Tokens: 1200/8192",
  timestamp,
  acpSource,
  channelId,
});

/** Streaming assistant message: headline is the (growing) first line. */
const assistantMessage = (id, text, timestamp, channelId = CHANNEL) => ({
  id,
  type: "message",
  role: "assistant",
  title: "",
  text,
  timestamp,
  channelId,
});

const secondsBeforeNow = (seconds) =>
  new Date(NOW - seconds * 1000).toISOString();

test("deriveActivityPillLabel returns the newest fresh headline, no rotation", () => {
  const editing = thought("Editing ChannelPane", secondsBeforeNow(2));
  const headline = deriveActivityPillLabel({
    channelId: CHANNEL,
    now: NOW,
    transcript: [thought("Reading files", secondsBeforeNow(4)), editing],
  });
  assert.deepEqual(headline, { id: editing.id, label: "Editing ChannelPane" });
});

test("deriveActivityPillLabel decays to null once the newest headline is stale", () => {
  const headline = deriveActivityPillLabel({
    channelId: CHANNEL,
    now: NOW,
    transcript: [thought("Editing ChannelPane", secondsBeforeNow(30))],
  });
  assert.equal(headline, null);
});

test("deriveActivityPillLabel honors a custom staleness window", () => {
  const editing = thought("Editing ChannelPane", secondsBeforeNow(30));
  const headline = deriveActivityPillLabel({
    channelId: CHANNEL,
    now: NOW,
    staleAfterMs: 60_000,
    transcript: [editing],
  });
  assert.deepEqual(headline, { id: editing.id, label: "Editing ChannelPane" });
});

test("deriveActivityPillLabel ignores other-channel items", () => {
  const inChannel = thought("In-channel work", secondsBeforeNow(3));
  const headline = deriveActivityPillLabel({
    channelId: CHANNEL,
    now: NOW,
    transcript: [
      inChannel,
      thought("Other-channel work", secondsBeforeNow(1), OTHER_CHANNEL),
    ],
  });
  assert.deepEqual(headline, { id: inChannel.id, label: "In-channel work" });
});

test("deriveActivityPillLabel lets spine work headline over fresher metadata reads", () => {
  const realWork = thought("Real work", secondsBeforeNow(4));
  const headline = deriveActivityPillLabel({
    channelId: CHANNEL,
    now: NOW,
    transcript: [realWork, metadata("Prompt context", secondsBeforeNow(1))],
  });
  assert.deepEqual(headline, { id: realWork.id, label: "Real work" });
});

test("deriveActivityPillLabel falls back to metadata when no spine items exist", () => {
  const context = metadata("Prompt context", secondsBeforeNow(5));
  const headline = deriveActivityPillLabel({
    channelId: CHANNEL,
    now: NOW,
    transcript: [context],
  });
  assert.deepEqual(headline, { id: context.id, label: "Prompt context" });
});

test("deriveActivityPillLabel returns null for an empty transcript", () => {
  const headline = deriveActivityPillLabel({
    channelId: CHANNEL,
    now: NOW,
    transcript: [],
  });
  assert.equal(headline, null);
});

test("deriveActivityPillLabel never headlines usage/commands meta frames", () => {
  const realWork = thought("Real work", secondsBeforeNow(4));
  const headline = deriveActivityPillLabel({
    channelId: CHANNEL,
    now: NOW,
    transcript: [
      realWork,
      lifecycleMeta("usage_update", secondsBeforeNow(2)),
      lifecycleMeta("available_commands_update", secondsBeforeNow(1)),
    ],
  });
  // Meta frames are skipped entirely — the older real action still headlines.
  assert.deepEqual(headline, { id: realWork.id, label: "Real work" });
});

test("deriveActivityPillLabel returns null when only meta frames are fresh", () => {
  const headline = deriveActivityPillLabel({
    channelId: CHANNEL,
    now: NOW,
    transcript: [lifecycleMeta("usage_update", secondsBeforeNow(1))],
  });
  assert.equal(headline, null);
});

test("deriveActivityPillLabel keeps a stable id while a message streams", () => {
  const first = deriveActivityPillLabel({
    channelId: CHANNEL,
    now: NOW,
    transcript: [assistantMessage("msg-1", "Pass 1: reading", NOW_ISO)],
  });
  const extended = deriveActivityPillLabel({
    channelId: CHANNEL,
    now: NOW,
    transcript: [
      assistantMessage("msg-1", "Pass 1: reading the composer wiring", NOW_ISO),
    ],
  });
  // Same item id: the pill updates text in place instead of re-animating.
  assert.equal(first.id, "msg-1");
  assert.equal(extended.id, "msg-1");
  assert.equal(extended.label, "Pass 1: reading the composer wiring");
});

test("deriveAgentActivityOrder puts the most recently active agent first", () => {
  const transcripts = new Map([
    ["alpha", [thought("Older work", secondsBeforeNow(20))]],
    ["beta", [thought("Newer work", secondsBeforeNow(2))]],
  ]);
  const order = deriveAgentActivityOrder({
    channelId: CHANNEL,
    getTranscript: (pubkey) => transcripts.get(pubkey) ?? [],
    pubkeys: ["alpha", "beta"],
  });
  assert.deepEqual(order, ["beta", "alpha"]);
});

test("deriveAgentActivityOrder keeps roster order for agents with no activity", () => {
  const transcripts = new Map([
    ["gamma", [thought("Only worker", secondsBeforeNow(5))]],
  ]);
  const order = deriveAgentActivityOrder({
    channelId: CHANNEL,
    getTranscript: (pubkey) => transcripts.get(pubkey) ?? [],
    pubkeys: ["alpha", "beta", "gamma"],
  });
  assert.deepEqual(order, ["gamma", "alpha", "beta"]);
});

test("deriveAgentActivityOrder ignores other-channel activity", () => {
  const transcripts = new Map([
    ["alpha", [thought("In-channel", secondsBeforeNow(30))]],
    ["beta", [thought("Elsewhere", secondsBeforeNow(1), OTHER_CHANNEL)]],
  ]);
  const order = deriveAgentActivityOrder({
    channelId: CHANNEL,
    getTranscript: (pubkey) => transcripts.get(pubkey) ?? [],
    pubkeys: ["alpha", "beta"],
  });
  assert.deepEqual(order, ["alpha", "beta"]);
});

test("deriveAgentActivityOrder is stable for identical timestamps", () => {
  const sameTime = secondsBeforeNow(3);
  const transcripts = new Map([
    ["alpha", [thought("Tied A", sameTime)]],
    ["beta", [thought("Tied B", sameTime)]],
  ]);
  const order = deriveAgentActivityOrder({
    channelId: CHANNEL,
    getTranscript: (pubkey) => transcripts.get(pubkey) ?? [],
    pubkeys: ["alpha", "beta"],
  });
  assert.deepEqual(order, ["alpha", "beta"]);
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
