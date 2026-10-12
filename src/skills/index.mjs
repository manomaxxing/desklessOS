// The skill a deployment runs: SKILL=pilot (the default: notes plus the
// discovery week, config/discovery.json) or SKILL=office (the order demo).
export async function loadSkill(name = process.env.SKILL || "pilot") {
  if (name === "pilot") return import("./pilot.mjs");
  if (name === "office") return import("./office.mjs");
  throw new Error(`unknown SKILL "${name}" (pilot | office)`);
}
