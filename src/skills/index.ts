// The skill a deployment runs: the notebook persona with the research week
// (src/skills/from-templates.ts). Max's own line loads "admin" separately.
import { loadSkillFromTemplates } from "./from-templates.ts";
import type { Skill } from "./from-templates.ts";

export async function loadSkill(name = "pilot"): Promise<Skill> {
  if (name !== "pilot") throw new Error(`unknown skill "${name}" (pilot)`);
  return loadSkillFromTemplates(name);
}
