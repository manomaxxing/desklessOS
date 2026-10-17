// People: the list, their edits, and Toni calling them on WhatsApp (may she, ask him, call now).
import type { ApiDeps } from "../deps.ts";
import type { Route, RouteCtx } from "../router.ts";
import type { CallNow } from "../../calls/call-now.ts";
import { userPatchIn } from "../../memory/users.ts";
import { FEATURES } from "../../features.ts";
import { locales } from "../../locale/index.ts";
import { fail, param } from "../router.ts";

export function peopleRoutes({ memory, skill, scheduler, whatsappOut, monitor }: ApiDeps, placeCall: (body: CallNow) => Promise<unknown>): Route[] {
  const by = (ctx: RouteCtx) => ctx.who.session?.n ?? "dev";
  const userOrFail = async (id: string) => {
    const u = await memory.getUser(id);
    if (!u) throw fail(404, "no such person");
    return u;
  };
  return [
    ["GET", "/api/users", "admin", async () => ({ users: await memory.listUsers(), outbound: Boolean(scheduler) })],
    // May Toni call him (his permission in WhatsApp)?
    ["GET", /^\/api\/users\/([\w-]+)\/whatsapp$/, "admin", async ctx => {
      const u = await userOrFail(param(ctx));
      if (!whatsappOut) return { available: false, why: "WhatsApp isn't set up on this server" };
      if (!u.phone) return { available: false, why: "no phone number" };
      return { available: true, ...(await whatsappOut.callPermission(u.phone).catch((err: Error) => ({ status: "unknown", error: err.message }))) };
    }],
    // Ask him for it (a message with an Allow button; works within 24 h of his last message or call).
    ["POST", /^\/api\/users\/([\w-]+)\/whatsapp\/ask$/, "admin", async ctx => {
      const u = await userOrFail(param(ctx));
      if (!whatsappOut || !u.phone) throw fail(400, "no WhatsApp for this person");
      const text = locales().persona(u.lang, skill.PERSONA)?.callPermission;
      if (typeof text !== "string" || !text) throw fail(500, `no callPermission line for ${u.lang}`);
      await whatsappOut.requestCallPermission({ to: u.phone, text }).catch((err: Error) => {
        throw fail(409, /131047|re-?engagement|24 ?h/i.test(err.message) ? `His WhatsApp chat is closed: ${u.name} has to call or write to Toni first (then it's open for 24 hours).`
          : /131030/.test(err.message) ? "His number isn't on the test number's recipient list in Meta yet." : err.message);
      });
      monitor.system(`asked ${u.name} on WhatsApp to allow Toni's calls (${by(ctx)})`);
      return { ok: true };
    }],
    // { focus?: what Toni should find out, rehearse?: true → to Max's own phone (the demo's number), as a call to him }
    ["POST", /^\/api\/users\/([\w-]+)\/call$/, "admin", async ctx => {
      const u = await userOrFail(param(ctx));
      const { body } = ctx;
      if (!u.phone) throw fail(400, `${u.name} has no phone number`);
      if (u.outboundPaused && !body.rehearse) throw fail(409, `calls to ${u.name} are paused`);
      if (await memory.userOnCall(u.id)) throw fail(409, `${u.name} is on a call right now`);
      const focus = String(body.focus ?? "").trim();
      const objectives = [{ template: "discovery.day", params: focus ? { focus } : {} }];
      let to = u.phone;
      let rehearsalOf: string | null = null;
      if (body.rehearse) {
        const demo = (await memory.listUsers()).find(x => x.demo);
        if (!demo?.phone) throw fail(400, "a rehearsal rings the demo's number: give the demo a phone (yours) first");
        if (demo.id === u.id) throw fail(400, "this is the demo: just call it");
        to = demo.phone;
        rehearsalOf = u.id;
      }
      const placed = await placeCall({ to, rehearsalOf, objectives });
      monitor.system(`${by(ctx)}: Toni calls ${rehearsalOf ? `the demo's phone, playing a call to ${u.name}` : u.name}${focus ? ` (${focus})` : ""}`);
      return placed;
    }],
    ["POST", /^\/api\/users\/([\w-]+)$/, "admin", async ctx => {
      const id = param(ctx);
      const before = await memory.getUser(id);
      const u = await memory.updateUser(id, userPatchIn(ctx.body));
      if (!u) throw fail(404, "no such person");
      // A feature just switched on: Toni tells him once, at the end of his next call (src/features.ts).
      for (const f of FEATURES.filter(f => u.features[f] && !before?.features?.[f])) {
        const message = locales().persona(u.lang, skill.PERSONA)?.features?.[f];
        if (!message) continue;
        const o = await memory.objectives.create({ template: "feature.intro", params: { feature: f, message }, userId: u.id, lang: u.lang, createdBy: ctx.who.session?.n ?? "admin" });
        monitor.system(`${u.name}: ${f} on; Toni tells him in his next call (${o.id})`);
      }
      monitor.system(`person ${u.name}: phone ${u.phone || "-"}, outbound calls ${u.consentOutboundAt ? "agreed" : "not agreed"}${u.outboundPaused ? " (paused)" : ""}`);
      return { user: u };
    }],
  ];
}
