// The skill a deployment runs: the notebook persona with the research week
// (src/skills/from-templates.mjs). Max's own line loads "admin" separately.
import { loadSkillFromTemplates } from "./from-templates.mjs";

export async function loadSkill(name = "pilot") {
  if (name !== "pilot") throw new Error(`unknown skill "${name}" (pilot)`);
  return loadSkillFromTemplates(name);
}
