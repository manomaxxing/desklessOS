// The People card's edit as it arrives over HTTP (src/memory/users.ts userPatchIn): types checked
// before anything is stored, a plain 400 otherwise.
import { test } from "node:test";
import assert from "node:assert/strict";
import { userPatchIn } from "../src/memory/users.ts";

const status400 = (err: { status?: number }) => err.status === 400;

test("People card: what the page sends comes through as it is", () => {
  const body = {
    phone: "+49 151 1234 5678", timezone: "Europe/Berlin", callWindow: { days: [1, 2, 3, 4, 5], from: "08:00", to: "18:00" },
    consentOutbound: true, outboundPaused: false, business: { name: "Fliesen Mico", vatRate: "19" },
    features: { quotes: true, unknown_feature: true }, lists: { jobs: "", site: "", siteMax: "", levels: "" },
  };
  const patch = userPatchIn(body);
  assert.equal(patch.phone, "+49 151 1234 5678");
  assert.deepEqual(patch.callWindow, { days: [1, 2, 3, 4, 5], from: "08:00", to: "18:00" });
  assert.equal(patch.consentOutbound, true);
  assert.deepEqual(patch.features, { quotes: true }, "only features that exist");
  assert.deepEqual(userPatchIn({ phone: "" }), { phone: null }, "an empty phone clears it");
  assert.deepEqual(userPatchIn({}), {}, "what isn't sent isn't changed");
});

test("People card: a field of the wrong type, or a language we don't speak, is a 400", () => {
  for (const body of [
    { phone: 4915112345678 }, { timezone: ["Europe/Berlin"] }, { consentOutbound: "true" }, { outboundPaused: 1 },
    { business: "Fliesen Mico" }, { features: { quotes: "yes" } }, { lists: null }, { lang: "xx-nope" }, { callWindow: { days: [8] } },
  ]) assert.throws(() => userPatchIn(body), status400, JSON.stringify(body));
});
