// What the API is built from (src/app.ts puts it together).

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { Config } from "../config.ts";
import type { Memory } from "../memory/pg.ts";
import type { Endpoint } from "../types/gemini.ts";
import type { Log, Turn } from "../types/common.ts";
import type { Template } from "../types/agenda.ts";
import type { Recap } from "../memory/rows.ts";
import type { Session } from "./access.ts";

/** A phone line's adapter (src/telephony/): its webhooks, its WebSocket, and calling out. */
export interface Adapter {
  id: string;
  http?(req: IncomingMessage, res: ServerResponse, url: URL): boolean | Promise<boolean>;
  upgrade?(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL): boolean;
  dialOut?(o: { to: string; userId?: string | null; jobId?: string | null; extra?: Record<string, unknown> }): Promise<{ callId: string; [key: string]: unknown }>;
}

/** The skill as the API uses it: templates, params checks, the persona's name and lines. */
export interface ApiSkill {
  PERSONA: string;
  persona?: { agentLabel?: string };
  templates: Map<string, Template>;
  objectiveParams(templateId: string, params: unknown): Record<string, unknown>;
}

export interface ApiDeps {
  cfg: Config;
  skill: ApiSkill;
  memory: Memory;
  queue: { list(): Promise<unknown[]> };
  requests: {
    list(): Promise<unknown[]>;
    get(id: string): Promise<unknown | null>;
    view(r: unknown): unknown;
    plan(o: { instruction: unknown; by: string }): Promise<unknown>;
    planConversation(o: { userId: string | null; focus: string; mode: string; by: string }): Promise<unknown>;
    revise(id: string, body: Record<string, unknown>): Promise<unknown>;
    approve(id: string, body: Record<string, unknown>): Promise<{ card: { summary?: string } | null; instruction: string }>;
    cancel(id: string): Promise<unknown>;
  };
  auth: {
    enabled: boolean;
    twoFactor: boolean;
    session(token: string): Session | null;
    login(o: { code: unknown; totp: unknown; ip: string }): LoginOut;
  };
  team: {
    check(session: Session | null): Promise<Session | null>;
    login(o: { email: unknown; password: unknown; ip: string }): Promise<LoginOut>;
    list(): Promise<unknown[]>;
    invite(o: { email: unknown; role: unknown; by: string }): Promise<{ member: { email: string; role: string }; token: string }>;
    inviteInfo(token: string): Promise<unknown | null>;
    accept(o: { token: string; name: unknown; password: unknown; ip?: string }): Promise<{ member: { email: string }; token: string }>;
    remove(id: string, o: { by: string | null }): Promise<{ email: string }>;
  } | null;
  notifier: { channels: string[] };
  monitor: {
    system(text: string, level?: "info" | "warn" | "error"): void;
    list(): Promise<unknown[]>;
    systemLog(): unknown[];
    record: boolean;
    get(id: string): Promise<Record<string, unknown> | null>;
    audioFile(id: string, name: string): string | null;
    subscribe(fn: (msg: unknown) => void): () => void;
  };
  background: { tick(): Promise<unknown>; mode: string };
  scheduler: { list(): Promise<unknown[]> } | null;
  host: { calls: Map<string, unknown> };
  clips: Promise<unknown>;
  endpoint: Endpoint;
  fish: { model: string };
  adapters: Adapter[];
  writeRecap: ((o: { turns: Turn[]; name: string | null; lang: string | null; startedAt: number | string | Date }) => Promise<Recap>) | null;
  quotes: { forCall(callId: string): Promise<unknown[]>; get(id: string): Promise<{ data: Parameters<typeof import("../quotes/pdf.ts").renderQuotePdf>[0] } | null> } | null;
  whatsappOut: {
    callPermission(to: string): Promise<Record<string, unknown>>;
    requestCallPermission(o: { to: string; text: string }): Promise<unknown>;
  } | null;
  log: Log;
}

export type LoginOut = { error: string; status?: number } | { needTotp: true } | { token: string; member?: { email: string } };
