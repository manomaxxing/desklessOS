// The monitor's live feed (/monitor-ws): every call's events as they happen.
// It reconnects with backoff, and closes while the page is hidden (an open socket keeps a
// request, and so the instance, busy on a server billed per request); on every (re)open the
// page reloads what it shows, since whatever happened in between was missed.

import { wsUrl } from "./api.ts";
import type { MonitorMsg } from "./types.ts";

export type FeedStatus = "connecting" | "live" | "lost" | "paused";
export interface FeedOptions {
  onMessage(msg: MonitorMsg): void;
  /** Opened (the first time and after every gap): load the state again. */
  onOpen(): void;
  onStatus(status: FeedStatus): void;
}

const MAX_DELAY_MS = 30_000;

export function openFeed({ onMessage, onOpen, onStatus }: FeedOptions): { close(): void } {
  let ws: WebSocket | null = null;
  let retries = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  function connect(): void {
    clearTimeout(timer);
    if (closed || document.hidden || ws) return;
    onStatus(retries ? "lost" : "connecting");
    const sock = new WebSocket(wsUrl("/monitor-ws"));
    ws = sock;
    sock.onopen = () => { retries = 0; onStatus("live"); onOpen(); };
    sock.onmessage = e => {
      let msg: MonitorMsg;
      try { msg = JSON.parse(String(e.data)) as MonitorMsg; } catch { return; }
      onMessage(msg);
    };
    sock.onclose = () => {
      if (ws !== sock) return; // closed on purpose (hidden): visibilitychange handles it
      ws = null;
      if (closed) return;
      onStatus("lost");
      const delay = Math.min(MAX_DELAY_MS, 1000 * 2 ** retries++) * (0.75 + Math.random() * 0.5);
      timer = setTimeout(connect, delay);
    };
  }
  function drop(): void {
    clearTimeout(timer);
    const sock = ws;
    ws = null;
    sock?.close();
  }
  document.addEventListener("visibilitychange", () => {
    if (closed) return;
    if (document.hidden) { drop(); onStatus("paused"); } else { retries = 0; connect(); }
  });
  connect();
  return { close() { closed = true; drop(); } };
}
