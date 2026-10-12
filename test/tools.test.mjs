import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defineTool, createToolRunner, hashValue } from "../src/tools/registry.mjs";
import { callTools, orderExecute } from "../src/tools/index.mjs";
import { createMemory } from "../src/store/memory.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const ctx = (extra = {}) => ({ callId: "c1", confirmed: true, signal: new AbortController().signal, ...extra });

test("defineTool checks the spec", () => {
  assert.throws(() => defineTool({ name: "Bad-Name", description: "d", run() {} }), /lowercase/);
  assert.throws(() => defineTool({ name: "x", description: "d" }), /run missing/);
  assert.throws(() => defineTool({ name: "x", description: "d", effect: "delete", run() {} }), /effect/);
  const t = defineTool({ name: "x", description: "d", run() {} });
  assert.equal(t.effect, "read");
  assert.deepEqual(t.parameters, { type: "OBJECT", properties: {} });
});

test("declarations: only what the model needs, only tools available on this call", () => {
  const runner = createToolRunner({ tools: [
    defineTool({ name: "a", description: "A", run() {}, effect: "write" }),
    defineTool({ name: "b", description: "B", run() {}, available: () => false }),
  ] });
  assert.deepEqual(runner.declarations(), [{ name: "a", description: "A", parameters: { type: "OBJECT", properties: {} } }]);
});

test("unknown tools and unconfirmed writes are refused, never run", async () => {
  let ran = 0;
  const runner = createToolRunner({ tools: [defineTool({ name: "send", description: "d", effect: "write", requiresConfirm: true, run: () => { ran++; return {}; } })] });
  assert.equal((await runner.run({ name: "nope" }, ctx())).status, "unknown");
  const o = await runner.run({ name: "send", args: {} }, ctx({ confirmed: false }));
  assert.equal(o.status, "rejected");
  assert.match(o.result.error, /recap/);
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
    defineTool({ name: "slow", description: "d", timeoutMs: 20, run: () => sleep(200) }),
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

test("order_execute: the same order is the same write, however it's worded", () => {
  const tool = orderExecute({ execute() {} });
  const draft = { customer_name: "Peter Steinberger", customer_email: "Peter@Steinberger.com", needed_by: "2026-10-23", items: [{ catalog_id: "tile-gray-24", quantity: 400 }], summary: "first wording" };
  assert.equal(hashValue(tool.key(draft)), hashValue(tool.key({ ...draft, summary: "other wording", customer_email: "peter@steinberger.com" })));
  assert.notEqual(hashValue(tool.key(draft)), hashValue(tool.key({ ...draft, needed_by: "2026-10-22" })));
  assert.equal(tool.requiresConfirm, true);
  assert.equal(tool.effect, "write");
});

test("callTools: what each engine gets", () => {
  const memory = createMemory(mkdtempSync(path.join(tmpdir(), "tools-mem-")));
  const store = { list: () => [] };
  assert.deepEqual(callTools({ engine: "cascade", office: { execute() {} }, memory, store }).map(t => t.name), ["order_execute", "memory_search"]);
  assert.deepEqual(callTools({ engine: "live", memory, store }).map(t => t.name), ["memory_search", "end_call"]);
});

test("memory_search: offered only when the prompt can't show everyone; finds by sound-alike name", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tools-mem-"));
  try {
    const memory = createMemory(dir);
    const store = { list: () => [] };
    const runner = () => createToolRunner({ tools: callTools({ engine: "cascade", memory, store }) });
    memory.upsertCustomer({ name: "Familie Kowalski", place: "Radolfzell", summary: "Bad im OG, 12 m² Feinsteinzeug 60x60 anthrazit." }, { date: "2026-01-05" });
    assert.deepEqual(runner().declarations(), [], "everyone fits in the prompt");
    for (let i = 0; i < 25; i++) memory.upsertCustomer({ name: `Kunde ${i}`, place: "Konstanz", summary: `Job ${i}` }, { date: `2026-09-${String(i + 1).padStart(2, "0")}` });
    assert.equal(memory.hidden({ notes: [] }), 1);
    assert.deepEqual(runner().declarations().map(d => d.name), ["memory_search"]);
    const found = await runner().run({ name: "memory_search", args: { query: "Kowalsky in Radolfzell" } }, ctx());
    assert.equal(found.status, "ok");
    assert.equal(found.result.results[0].name, "Familie Kowalski");
    assert.match(found.result.results[0].summary, /anthrazit/);
    assert.equal(memory.search("anthrazit", { notes: [] })[0].name, "Familie Kowalski", "other words are found in what we know");
    assert.deepEqual(memory.search("und die", { notes: [] }), [], "stopwords alone find nothing");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
