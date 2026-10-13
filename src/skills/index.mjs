// The skill a deployment runs, built from a persona and templates
// (src/skills/from-templates.mjs): SKILL=pilot (the default: the notebook
// persona with the discovery week) or SKILL=office (the order demo).
import { loadSkillFromTemplates } from "./from-templates.mjs";

export async function loadSkill(name = process.env.SKILL || "pilot") {
  if (!["pilot", "office"].includes(name)) throw new Error(`unknown SKILL "${name}" (pilot | office)`);
  return loadSkillFromTemplates(name);
}
