// What the monitor knows, and how it stays current: the call list and the connection log from
// /api/calls, the selected call from /api/calls/<id>, and /monitor-ws for everything after.
// Every time the feed (re)opens, both are loaded again: a call that ended in a gap shows as
// ended. While a load is in flight the feed's messages wait and are applied after it, so
// nothing that happened meanwhile is lost; of overlapping loads, the latest wins.

import { $, html, setHtml } from "../shared/html.ts";
import { getJson, seg, ApiError } from "../shared/api.ts";
import { openFeed, type FeedStatus } from "../shared/live.ts";
import { latest } from "../shared/poll.ts";
import { renderList, renderSystem } from "./list.ts";
import { showCall, showNothing, addEvent, updateHead, shownCallId } from "./detail.ts";
import type { CallDetail, CallSummary, CallsOut, MonitorMsg, SystemEntry, TimelineEvent } from "../shared/types.ts";

const MAX_CALLS = 100; // as many as the server lists
const MAX_SYSTEM = 100;
const LIST_EVENTS = new Set(["heard", "note", "saved", "connected", "memory", "cost"]); // what the list shows

let calls: CallSummary[] = [];
let system: SystemEntry[] = [];
let selectedId: string | null = null;
let listQueue: MonitorMsg[] | null = null; // the feed's messages while the list loads
let pending: { events: TimelineEvent[]; head: Partial<CallDetail> } | null = null; // the selected call's, while it loads
let wanted = new URLSearchParams(location.search).get("call"); // /monitor?call=<id> (the admin page's link)
const listLoad = latest(), callLoad = latest();
let following = (): boolean => false;
let stopFollowing = (): void => {};
let feed: { close(): void } | null = null;

// ---------- drawing, at most once a frame ----------
let listDirty = false, systemDirty = false;
function redraw(): void {
  if (listDirty) renderList(calls, selectedId);
  if (systemDirty) renderSystem(system);
  listDirty = systemDirty = false;
}
function later(list: boolean, sys = false): void {
  const was = listDirty || systemDirty;
  listDirty ||= list;
  systemDirty ||= sys;
  if (!was && (listDirty || systemDirty)) requestAnimationFrame(redraw);
}

// ---------- the list ----------
/** A message onto the list and the log; true when the list shows something new. */
function applyToList(msg: MonitorMsg): boolean {
  if (msg.type === "call") {
    const i = calls.findIndex(c => c.id === msg.call.id);
    if (i >= 0) calls[i] = msg.call;
    else {
      calls.unshift(msg.call);
      if (calls.length > MAX_CALLS) calls.length = MAX_CALLS;
    }
    return true;
  }
  if (msg.type === "system") {
    system.push(msg.entry);
    if (system.length > MAX_SYSTEM) system.splice(0, system.length - MAX_SYSTEM);
    later(false, true);
    return false;
  }
  const c = calls.find(x => x.id === msg.id);
  const ev = msg.ev;
  if (!c || ev.trimmed) return false;
  if (ev.event === "heard") c.turns = (c.turns ?? 0) + 1;
  if (ev.event === "note") c.summary = ev.note?.summary ?? c.summary;
  if (ev.event === "memory") c.summary = ev.summary ?? c.summary;
  if (ev.event === "cost") c.usd = ev.totals?.usd ?? c.usd;
  if (ev.event === "saved") c.savedNoteId = ev.id;
  if ((ev.event === "connected" || ev.event === "heard") && ev.lang) c.lang = ev.lang;
  return LIST_EVENTS.has(ev.event);
}

function notLoggedIn(): void {
  feed?.close();
  feed = null;
  setStatus("lost", "Not logged in");
  setHtml($("calls"), html`<div class="empty">Not logged in: log in on <a href="/admin">the admin page</a>, then reload.</div>`);
}

export async function loadList(): Promise<void> {
  const signal = listLoad.start();
  listQueue ??= [];
  try {
    const body = await getJson<CallsOut>("/api/calls", { signal });
    calls = body.calls.slice(0, MAX_CALLS);
    system = body.system.slice(-MAX_SYSTEM);
    const queued = listQueue ?? [];
    listQueue = null;
    for (const m of queued) applyToList(m);
    $("rec").textContent = body.recording ? "Recording on" : "Recording off";
    renderList(calls, selectedId);
    renderSystem(system);
    if (wanted && !selectedId) { stopFollowing(); void select(wanted); }
    else if (!selectedId && calls[0]) void select(calls[0].id);
    wanted = null;
  } catch (err) {
    if (signal.aborted) return; // a newer load is on its way
    listQueue = null;
    if (err instanceof ApiError && err.status === 401) return notLoggedIn();
    if (!calls.length) setHtml($("calls"), html`<div class="empty">Couldn't load the calls: ${(err as Error).message}</div>`);
  }
}

// ---------- the selected call ----------
export async function select(id: string): Promise<void> {
  selectedId = id;
  pending = { events: [], head: {} };
  renderList(calls, selectedId);
  const signal = callLoad.start();
  try {
    const c = await getJson<CallDetail>(`/api/calls/${seg(id)}`, { signal });
    if (selectedId !== id || !pending) return;
    // What the feed brought while it loaded, unless the answer had it already.
    const seen = new Set(c.events.slice(-500).map(e => JSON.stringify(e)));
    for (const ev of pending.events) if (!seen.has(JSON.stringify(ev))) c.events.push(ev);
    if (pending.head.endedAt && !c.endedAt) Object.assign(c, pending.head);
    pending = null;
    showCall(c);
  } catch (err) {
    if (signal.aborted || selectedId !== id) return;
    pending = null;
    if (err instanceof ApiError && err.status === 401) return notLoggedIn();
    showNothing(`Couldn't load this call: ${(err as Error).message}`);
  }
}

function onMessage(msg: MonitorMsg): void {
  if (listQueue) listQueue.push(msg);
  else if (applyToList(msg)) later(true);
  if (msg.type === "call") {
    const { id, endedAt, endedReason } = msg.call;
    if (!endedAt && following() && selectedId !== id) { void select(id); return; }
    if (id !== selectedId) return;
    if (shownCallId() === id) updateHead({ endedAt, endedReason });
    else if (pending) Object.assign(pending.head, { endedAt, endedReason });
  } else if (msg.type === "event" && msg.id === selectedId) {
    if (shownCallId() === msg.id) addEvent(msg.ev);
    else pending?.events.push(msg.ev);
  }
}

// ---------- the feed ----------
const STATUS: Record<FeedStatus, [string, string]> = { connecting: ["connecting…", ""], live: ["● Live", "live"], lost: ["Reconnecting…", "lost"], paused: ["Paused", ""] };
function setStatus(cls: string, text: string): void {
  const pill = $("feed");
  pill.textContent = text;
  pill.className = `pill${cls ? ` ${cls}` : ""}`;
}

export function startFeed(opts: { following: () => boolean; stopFollowing: () => void }): void {
  following = opts.following;
  stopFollowing = opts.stopFollowing;
  let checked = false; // asked over HTTP why, in this outage
  feed = openFeed({
    onMessage,
    onOpen: () => {
      checked = false;
      void loadList();
      if (selectedId) void select(selectedId); // what it missed
    },
    onStatus: s => {
      const [text, cls] = STATUS[s];
      setStatus(cls, text);
      // The feed can't (re)connect: once per outage the list over HTTP, which says why (a login that ran out).
      if (s === "lost" && !checked) { checked = true; void loadList(); }
    },
  });
}
