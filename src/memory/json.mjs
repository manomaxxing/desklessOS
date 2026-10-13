// Memory on JSON files (data/notes, data/memory, data/discovery,
// data/agenda): the pre-Postgres stores behind the memory v2 interface, and
// the rollback for MEMORY_BACKEND=pg. One user, everything in every prompt
// (up to 25 customers), as before.

import { createNotesStore } from "../store/notes.mjs";
import { createMemory } from "../store/memory.mjs";
import { createDiscovery, withDiscovery } from "../store/discovery.mjs";
import { createObjectives } from "../store/objectives.mjs";
import { dataDir, readJson, writeJson } from "../store/files.mjs";
import { mkdirSync } from "node:fs";
import path from "node:path";

export function openJsonMemory({ skill }) {
  const store = createNotesStore();
  const discovery = skill.framework ? createDiscovery({ framework: skill.framework }) : null;
  const memory = discovery ? withDiscovery(createMemory(), discovery) : createMemory();
  const objectives = createObjectives({ skill });
  const user = { id: "default", name: skill.profile?.owner ?? skill.profile?.name ?? "", lang: skill.DEFAULT_LANG };

  // Admin requests (src/admin/requests.mjs): data/admin/requests.json, newest first.
  const adminDir = dataDir("admin", "ADMIN_DIR");
  const requestsFile = path.join(adminDir, "requests.json");
  let requestCache = null;
  const allRequests = () => (requestCache ??= readJson(requestsFile, []));
  const saveRequests = list => { mkdirSync(adminDir, { recursive: true }); writeJson(requestsFile, list); requestCache = list; };
  const requests = {
    async create(r) { saveRequests([r, ...allRequests()]); return r; },
    get: async id => allRequests().find(r => r.id === id) ?? null,
    list: async ({ limit = 100 } = {}) => allRequests().slice(0, limit),
    async update(id, patch) {
      const list = structuredClone(allRequests());
      const r = list.find(x => x.id === id);
      if (!r) return null;
      Object.assign(r, patch, { updatedAt: new Date().toISOString() });
      saveRequests(list);
      return r;
    },
    byObjective: async objectiveId => allRequests().find(r => r.objectiveId === objectiveId) ?? null,
    pendingNotifications: async () => allRequests().filter(r => ["pending", "failed"].includes(r.notifyStatus) && (r.notifyAttempts ?? 0) < 5),
  };

  // What the post-call step needs: the memory snapshot and applying its result.
  const postCall = {
    snapshot: async () => memory.snapshot(),
    async apply(result, meta) {
      const changed = memory.apply(result, meta);
      // Link the saved note to its customer, so the customer's entry carries the note's details.
      if (meta.noteId && changed.customer) store.update(meta.noteId, { customerId: changed.customer.id });
      return changed;
    },
  };

  return {
    kind: "json",
    store,

    /** Everything one call needs from memory, read once when it connects. */
    async openCall({ callId, direction = "inbound", at = new Date() }) {
      const notes = store.list();
      return {
        user,
        context: memory.context({ notes, today: at }),
        hidden: memory.hidden({ notes }),
        discovery,
        objectives: objectives.forCall({ direction, at }),
        search: async query => memory.search(query, { notes: store.list() }),
        saveNote: async note => store.save(note),
        endCall: async () => {},
        ...postCall,
        consolidationFailed: async job => memory.savePending(job),
        upsertCustomer: async (fields, meta) => memory.upsertCustomer(fields, meta),
        addAction: async action => memory.addAction(action),
        recordObjectives: async results => objectives.record(callId, results),
        recordToolRun: async () => {},
      };
    },

    /** Calls whose post-call step failed: retried by the server. */
    async pendingConsolidations() {
      return memory.listPending().map(job => ({ job, scope: postCall, done: async () => memory.removePending(job), failed: async () => {} }));
    },

    /** Who can be asked something: the one user of a JSON deployment. */
    listUsers: async () => [{ id: user.id, name: user.name, phone: skill.profile?.phone ?? "", lang: user.lang, role: "owner", consentOutboundAt: null }],
    requests,
    listNotes: async () => store.list(),
    memoryOverview: async () => ({ actions: memory.actions(), customers: Object.values(memory.customers()) }),
    setTaskStatus: async (id, status) => memory.setActionStatus(id, status),
    async discoveryOverview() {
      if (!discovery) return null;
      return { framework: discovery.framework, findings: discovery.findings(), questions: discovery.questions(), calls: discovery.calls(), next: discovery.next() };
    },
    objectives: {
      list: async () => objectives.list(),
      get: async id => objectives.get(id),
      create: async ({ userId: _u, ...spec }) => objectives.create(spec),
      cancel: async id => objectives.cancel(id),
    },
    async reset() { store.reset?.(); memory.reset(); objectives.reset(); requestCache = null; },
    async close() {},
  };
}
