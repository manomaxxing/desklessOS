import { test } from "node:test";
import assert from "node:assert/strict";
import { defineTool, createToolRunner, hashValue } from "../src/tools/registry.ts";
import { callTools } from "../src/tools/index.ts";
import { adminTools } from "../src/tools/admin.ts";
import type { AdminRequests } from "../src/tools/admin.ts";
import type { Request } from "../src/types/request.ts";
import type { ToolOutcome } from "../src/types/tool.ts";
import type { FoundCustomer } from "../src/types/call.ts";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const ctx = (extra = {}) => ({ callId: "c1", lang: "de", confirmed: true, signal: new AbortController().signal, ...extra });

test("defineTool checks the spec", () => {
  assert.throws(() => defineTool({ name: "Bad-Name", description: "d", run: () => ({}) }), /lowercase/);
  // @ts-expect-error: no run, on purpose
  assert.throws(() => defineTool({ name: "x", description: "d" }), /run missing/);
  // @ts-expect-error: not an effect, on purpose
  assert.throws(() => defineTool({ name: "x", description: "d", effect: "delete", run: () => ({}) }), /effect/);
  const t = defineTool({ name: "x", description: "d", run: () => ({}) });
  assert.equal(t.effect, "read");
  assert.deepEqual(t.parameters, { type: "OBJECT", properties: {} });
});

test("declarations: only what the model needs, only tools available on this call", () => {
  const runner = createToolRunner({ tools: [
    defineTool({ name: "a", description: "A", run: () => ({}), effect: "write" }),
    defineTool({ name: "b", description: "B", run: () => ({}), available: () => false }),
  ] });
  assert.deepEqual(runner.declarations(), [{ name: "a", description: "A", parameters: { type: "OBJECT", properties: {} } }]);
});

test("unknown tools and unconfirmed writes are refused, never run", async () => {
  let ran = 0;
  const runner = createToolRunner({ tools: [defineTool({ name: "send", description: "d", effect: "write", requiresConfirm: true, run: () => { ran++; return {}; } })] });
  assert.equal((await runner.run({ name: "nope" }, ctx())).status, "unknown");
  const o = await runner.run({ name: "send", args: {} }, ctx({ confirmed: false }));
  assert.equal(o.status, "rejected");
  assert.match(o.result.error, /NOT DONE: nothing was sent/);
  assert.equal(ran, 0);
});

test("a write runs once per key: repeats and concurrent duplicates get the first result", async () => {
  let ran = 0;
  const tool = defineTool({ name: "book", description: "d", effect: "write", key: i => ({ day: i.day }), run: async i => { ran++; await sleep(20); return { summary: `booked ${i.day}` }; } });
  const runner = createToolRunner({ tools: [tool] });
  const [a, b] = await Promise.all([runner.run({ name: "book", args: { day: "fri", note: "x" } }, ctx()), runner.run({ name: "book", args: { day: "fri", note: "y" } }, ctx())]);
  assert.equal(ran, 1);
  assert.deepEqual([a.status, b.status].sort(), ["ok", "repeated"]);
  assert.equal([a, b].find(o => o.status === "repeated").result.already_done, true);
  const c = await runner.run({ name: "book", args: { day: "thu" } }, ctx());
  assert.equal(c.status, "ok");
  assert.equal(ran, 2, "a different key is a different write");
});

test("a write waits for mayWrite; taken back means skipped", async () => {
  let ran = 0;
  const runner = createToolRunner({ tools: [defineTool({ name: "send", description: "d", effect: "write", run: () => { ran++; return {}; } })] });
  const o = await runner.run({ name: "send" }, ctx({ mayWrite: async () => false }));
  assert.equal(o.status, "skipped");
  assert.equal(ran, 0);
  let wrote = false;
  const ok = await runner.run({ name: "send" }, ctx({ mayWrite: async () => true, onWrite: () => { wrote = true; } }));
  assert.equal(ok.status, "ok");
  assert.equal(wrote, true);
});

test("a started write is never aborted; a read is", async () => {
  const ac = new AbortController();
  let finished = false;
  const runner = createToolRunner({ tools: [
    defineTool({ name: "write_it", description: "d", effect: "write", run: async () => { await sleep(30); finished = true; return { summary: "done" }; } }),
    defineTool({ name: "look", description: "d", run: async () => { await sleep(200); return {}; } }),
  ] });
  const w = runner.run({ name: "write_it" }, ctx({ signal: ac.signal }));
  await sleep(5);
  ac.abort();
  assert.equal((await w).status, "ok");
  assert.equal(finished, true);
  const ac2 = new AbortController();
  const r = runner.run({ name: "look" }, ctx({ signal: ac2.signal }));
  ac2.abort();
  assert.equal((await r).status, "aborted");
});

test("errors and timeouts come back as results; a failed write may run again", async () => {
  let tries = 0;
  const runner = createToolRunner({ tools: [
    defineTool({ name: "flaky", description: "d", effect: "write", run: () => { tries++; if (tries === 1) throw new Error("smtp down"); return { summary: "sent" }; } }),
    defineTool({ name: "slow", description: "d", timeoutMs: 20, run: () => sleep(200).then(() => ({})) }),
  ] });
  const first = await runner.run({ name: "flaky" }, ctx());
  assert.equal(first.status, "error");
  assert.equal(first.result.error, "smtp down");
  assert.equal((await runner.run({ name: "flaky" }, ctx())).status, "ok");
  const slow = await runner.run({ name: "slow" }, ctx());
  assert.equal(slow.status, "error");
  assert.match(slow.result.error, /no result after 20 ms/);
});

test("hashValue ignores key order", () => {
  assert.equal(hashValue({ a: 1, b: [1, { c: 2, d: 3 }] }), hashValue({ b: [1, { d: 3, c: 2 }], a: 1 }));
  assert.notEqual(hashValue({ a: 1 }), hashValue({ a: 2 }));
});

test("callTools: only what the call's templates allow", () => {
  const memory = { hidden: 0, search: async () => [] };
  const extra = [defineTool({ name: "request_create", description: "d", effect: "write", run: () => ({}) })];
  assert.deepEqual(callTools({ memory, extra }).map(t => t.name), ["request_create", "memory_search"]);
  assert.deepEqual(callTools({ memory, extra, allow: ["memory_search"] }).map(t => t.name), ["memory_search"]);
  assert.deepEqual(callTools({ engine: "live", memory }).map(t => t.name), ["memory_search", "end_call"], "Live hangs up with a tool");
});

test("memory_search: offered only when the prompt can't show everyone; passes his words on", async () => {
  const queries = [];
  const kowalski: FoundCustomer = { name: "Familie Kowalski", place: null, address: null, phone: null, last_contact: "", summary: "Bad im OG, anthrazit.", history: [], notes: [], open_todos: [] };
  const scope = hidden => ({ hidden, search: async q => { queries.push(q); return [kowalski]; } });
  const runner = hidden => createToolRunner({ tools: callTools({ memory: scope(hidden) }) });
  assert.deepEqual(runner(0).declarations(), [], "everyone fits in the prompt");
  assert.deepEqual(runner(1).declarations().map(d => d.name), ["memory_search"]);
  const found = await runner(1).run({ name: "memory_search", args: { query: "Kowalsky in Radolfzell" } }, ctx());
  assert.equal(found.status, "ok");
  assert.deepEqual(queries, ["Kowalsky in Radolfzell"]);
  assert.equal(found.result.results[0].name, "Familie Kowalski");
  assert.equal(found.summary, "found Familie Kowalski");
});

test("a write that needs his yes: the check may be asked late (his words written down only then)", async () => {
  let ran = 0, asked = 0;
  const runner = createToolRunner({ tools: [defineTool({ name: "send_it", description: "x", effect: "write", requiresConfirm: true, run: () => { ran++; return { ok: true }; } })] });
  const no = await runner.run({ name: "send_it", args: {} }, { callId: "c", lang: "de", confirmed: async () => { asked++; return false; } });
  assert.equal(no.status, "rejected");
  assert.equal(no.result.done, false);
  const yes = await runner.run({ name: "send_it", args: {} }, { callId: "c", lang: "de", confirmed: async () => { asked++; return true; } });
  assert.deepEqual([yes.status, ran, asked], ["ok", 1, 2]);
});

test("secret args (a PIN) are masked in the outcome the monitor logs; the tool gets them as they came", async () => {
  let got: unknown = null;
  const logged: ToolOutcome[] = [];
  const runner = createToolRunner({ tools: [defineTool({ name: "unlock", description: "d", effect: "write", secretArgs: ["pin"], run: i => { got = i.pin; return { ok: true }; } })], onRun: o => logged.push(o) });
  const o = await runner.run({ name: "unlock", args: { pin: "4711", door: "front" } }, ctx());
  assert.equal(got, "4711");
  assert.deepEqual(o.args, { pin: "***", door: "front" });
  assert.deepEqual(logged[0].args, o.args, "what onRun (tool_runs) gets too");
  assert.deepEqual((await runner.run({ name: "unlock", args: { door: "back" } }, ctx())).args, { door: "back" }, "nothing to mask");
});

// Max's own line (src/tools/admin.ts), with a fake request store.
function fakeRequests() {
  const store = new Map<string, Request>();
  let open = () => {};
  const gate = { closed: false, wait: () => new Promise<void>(r => { open = r; }), open: () => open() };
  const fake: AdminRequests & { planned: string[]; approved: string[]; gate: typeof gate } = {
    planned: [], approved: [], gate,
    async plan({ instruction }) {
      if (gate.closed) await gate.wait();
      fake.planned.push(instruction);
      const at = new Date().toISOString();
      const r: Request = {
        id: `req_${fake.planned.length}`, userId: null, instruction, planHash: null, turns: [], status: "draft", objectiveId: null, result: null, createdBy: "phone", createdAt: at, approvedAt: null, closedAt: null, notifiedAt: null, log: [], updatedAt: at,
        plan: { template: "inquiry", target: { userId: null, name: "Niko" }, params: {}, mode: "next_inbound" },
        card: { title: "", summary: `ask: ${instruction}`, who: "Niko", when: "next call", purpose: "", questions: [{ ask: "Wie?" }], warnings: [], clarifications: [], blocked: [] },
      };
      store.set(r.id, r);
      return { request: r, confirmToken: "t" };
    },
    get: async id => store.get(id) ?? null,
    async approve(id) {
      const r = store.get(id);
      if (!r) throw new Error(`no ${id}`);
      fake.approved.push(id);
      return { ...r, status: "approved" };
    },
    list: async () => [...store.values()],
  };
  return fake;
}
const auth = { confirmToken: () => "t" };

test("admin line: \"Müller\" and \"Möller\" are two drafts, not one", async () => {
  const requests = fakeRequests();
  const runner = createToolRunner({ tools: adminTools({ requests, auth, pin: "4711" }) });
  const a = await runner.run({ name: "request_create", args: { instruction: "Frag Müller nach dem Bad" } }, ctx());
  const b = await runner.run({ name: "request_create", args: { instruction: "Frag Möller nach dem Bad" } }, ctx());
  assert.deepEqual([a.result.request_id, b.result.request_id], ["req_1", "req_2"]);
  const same: { result: any } = await runner.run({ name: "request_create", args: { instruction: "frag Möller, nach dem Bad!" } }, ctx()); // the tool's JSON, read as it came
  assert.equal(same.result.note.startsWith("already drafted"), true, "the same words, other punctuation: the same draft");
});

test("admin line: a draft from a turn taken back can't be approved without its id; once read back, it can", async () => {
  const requests = fakeRequests();
  const runner = createToolRunner({ tools: adminTools({ requests, auth, pin: "4711" }) });
  requests.gate.closed = true;
  const ac = new AbortController();
  const planning = runner.run({ name: "request_create", args: { instruction: "Frag Niko nach dem Angebot" } }, ctx({ signal: ac.signal }));
  await sleep(5);
  ac.abort();
  assert.equal((await planning).status, "aborted", "he never heard this card");
  requests.gate.open(); // the planning finishes in the background
  await sleep(5);
  assert.deepEqual(requests.planned, ["Frag Niko nach dem Angebot"]);
  const blind = await runner.run({ name: "request_approve", args: { pin: "4711" } }, ctx());
  assert.match(blind.result.error, /nothing drafted on this call yet/);
  assert.deepEqual(requests.approved, []);
  requests.gate.closed = false;
  const heard: { result: any } = await runner.run({ name: "request_create", args: { instruction: "Frag Niko nach dem Angebot" } }, ctx()); // the tool's JSON, read as it came
  assert.match(heard.result.note, /already drafted/, "asked again: the same draft, no second plan");
  const approved = await runner.run({ name: "request_approve", args: { pin: "4711" } }, ctx());
  assert.equal(approved.result.approved, true);
  assert.deepEqual(requests.approved, ["req_1"]);
  assert.equal(approved.args.pin, "***", "the PIN never reaches the monitor");
});

test("admin line: a PIN set up without digits is no PIN (anything said without digits matched it)", async () => {
  const requests = fakeRequests();
  const runner = createToolRunner({ tools: adminTools({ requests, auth, pin: "geheim" }) });
  await runner.run({ name: "request_create", args: { instruction: "Frag Niko" } }, ctx());
  const o = await runner.run({ name: "request_approve", args: { pin: "keine Ahnung" } }, ctx());
  assert.match(o.result.error, /No PIN is set up/);
  assert.deepEqual(requests.approved, []);
});
