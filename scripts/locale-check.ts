// Checks that every enabled locale pack in locales/ is complete (npm run locale:check).
import { loadLocales } from "../src/locale/index.ts";
import { checkLocales } from "../src/locale/check.ts";

const locales = loadLocales();
const problems = checkLocales(locales);
for (const id of locales.enabled()) console.log(`${id} (${locales.name(id)}): ${problems[id] ? `${problems[id].length} problem(s)\n  - ${problems[id].join("\n  - ")}` : "ok"}`);
process.exit(Object.keys(problems).length ? 1 : 0);
