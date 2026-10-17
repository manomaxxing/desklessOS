// What Toni does for one person beyond notes, briefings and to-dos: switched on one at a
// time on their People card, so a new user meets Toni in small steps. Kept in
// users.profile.features as { id: "<when switched on>" }. Switching one on that has an
// intro line (locale pack: personas.notebook.features.<id>) queues a "feature.intro"
// objective: Toni says it once, at the end of the next call.
//   note_whatsapp   after a WhatsApp call, the note he confirmed goes into his chat (src/calls/after-call.ts)
//   quotes          the quote_send tool on WhatsApp calls (src/tools/quote.ts)

import type { Iso } from "./types/common.ts";
import type { FeatureId, Profile } from "./types/user.ts";

export const FEATURES: readonly FeatureId[] = ["note_whatsapp", "quotes"];

/** Whose features: a users row or a call scope's user (profile.features), or the API's shape (features). */
export type WithFeatures = { features?: Partial<Record<FeatureId, Iso>> | null; profile?: Pick<Profile, "features"> | null };

export const hasFeature = (user: WithFeatures | null | undefined, id: FeatureId): boolean => Boolean(user?.features?.[id] ?? user?.profile?.features?.[id]);

/** The demo has everything, to show it. */
export const allFeatures = (at: Iso = new Date().toISOString()): Partial<Record<FeatureId, Iso>> => Object.fromEntries(FEATURES.map(id => [id, at]));
