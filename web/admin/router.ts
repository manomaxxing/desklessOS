// The views, by the URL's #: #calls, #call/<id>, #requests (and #req_… for one request),
// #people; #invite=<token> is an invite link's form.

export type View =
  | { name: "calls" }
  | { name: "call"; id: string }
  | { name: "requests"; focus: string | null }
  | { name: "people" };

const hash = (): string => {
  try { return decodeURIComponent(location.hash.slice(1)); } catch { return location.hash.slice(1); } // a broken %-escape
};

export function currentView(): View {
  const h = hash();
  if (h.startsWith("call/")) return { name: "call", id: h.slice(5) };
  if (h === "requests") return { name: "requests", focus: null };
  if (h.startsWith("req_")) return { name: "requests", focus: h };
  if (h === "people") return { name: "people" };
  return { name: "calls" };
}

/** The token of an invite link (#invite=…), or null. */
export const inviteToken = (): string | null => (location.hash.startsWith("#invite=") ? location.hash.slice(8) : null);

export const callHref = (id: string): string => `#call/${encodeURIComponent(id)}`;
