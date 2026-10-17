// A scripted phone call without a phone (see src/testing/caller.ts).
//
//   npm run fake-dial -- --say "Ich komm grad von der Frau Müller in Haching…" --say "Passt."
//   npm run fake-dial -- --url wss://<host>/dial --signed --say "…"     (deployed, signed like Dial)
//   npm run fake-dial -- --url wss://<host>/dial --token <DEV_TOKEN> --say "…"   (deployed, as the test phone)
//   npm run fake-dial -- --wav caller.wav                                (your own 16 kHz recording)
//   npm run fake-dial -- --say "Ich komm grad von … [pause 3] … und die will ein neues Bad."   (a thinking pause mid-line)
//   npm run fake-dial -- --answer +4915100000000 --say "Hallo?" --say "Ja, klar."   (be called: OUTBOUND=fake)
// Mode, like the test phone's selector: --engine cascade|live  --model <gemini>  --mask typing|filler|none
//   --live-model <door:model>  --live-voice Kore

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { wav, wavData } from "../src/engine/audio.ts";
import { runCall, answerCall, describeEvent } from "../src/testing/caller.ts";
import { locales } from "../src/locale/index.ts";

const args = process.argv.slice(2);
const opt = (name: string, def?: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const says = args.flatMap((a, i) => (a === "--say" ? [args[i + 1]] : []));
const lang = opt("--lang", locales().defaultId);
const config = Object.fromEntries(Object.entries({ engine: opt("--engine"), model: opt("--model"), mask: opt("--mask"), liveModel: opt("--live-model"), liveVoice: opt("--live-voice") }).filter(([, v]) => v));
const utterances = opt("--wav") ? [wavData(readFileSync(opt("--wav"))).pcm] : null;
if (!utterances && !says.length) says.push("Hallo? Hörst du mich? Ich komm grad von einem Termin bei Herrn Huber in Pullach, Küche, Fliesenspiegel neu.");

const stamp = s => `${s.toFixed(1).padStart(5)}s`;
const onEvent = (ev, at) => { const line = describeEvent(ev); if (line) console.log(stamp(at), line); };
// --answer +49…: be the phone the server calls (OUTBOUND=fake); --reject no-answer|busy to not pick up.
const answer = opt("--answer");
if (answer && !opt("--say")) says.splice(0, says.length, "Hallo?");
const { agentAudio = Buffer.alloc(0) } = answer
  ? await answerCall({ base: opt("--url", "ws://localhost:8787/dial").replace(/\/dial\/?$/, ""), number: answer, token: opt("--token", ""), reject: opt("--reject"), lang, says, utterances, config, voice: opt("--voice"), onEvent, beforeRing: async () => console.log(`waiting for a call to ${answer}…`) })
  : await runCall({
    url: opt("--url", "ws://localhost:8787/dial"), lang, says, utterances, config,
    signed: args.includes("--signed"), token: opt("--token", ""), voice: opt("--voice"), from: opt("--from"), onEvent,
  });
mkdirSync("data", { recursive: true });
writeFileSync("data/fake-dial-agent.wav", wav(agentAudio));
console.log("done. agent audio → data/fake-dial-agent.wav");
process.exit(0);
