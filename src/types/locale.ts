// A locale pack (locales/<id>.json): voices, number formats, turn-taking word lists, persona lines.
import type { LangId } from "./common.ts";

export interface LexiconSource {
  digits?: string[];
  dangling?: string[];
  hold?: string[];
  holdTail?: string[];
  fillerWords?: string[];
  agentBackchannel?: string[];
  affirm?: string[];
  send?: string[];
  negate?: string[];
  goOn?: string[];
  unclear?: string[];
  stopwords?: string[];
  letters?: string;
}

/** The word lists, compiled once per pack. */
export interface Lexicon {
  dangling: Set<string>;
  hold: RegExp;
  fillerPrefix: RegExp;
  agentBackchannel: RegExp;
  stopwords: Set<string>;
  affirm: RegExp;
  send: RegExp;
  negate: RegExp;
  letters: string;
  unclear: string[];
}

/** One persona's lines in one language. */
export interface PersonaLines {
  greeting?: string;
  firstGreeting?: string;
  outboundGreeting?: string;
  wrapUp?: string;
  backchannel?: string;
  fillers?: string[];
  oops?: string[];
  working?: string;
  looking?: string;
  callPermission?: string;
  features?: Record<string, string>;
  examples?: Record<string, string | string[]>;
  [key: string]: unknown;
}

export interface LocalePack {
  id: LangId;
  name: string;
  nativeName?: string;
  bcp47: string;
  status: "enabled" | "beta" | "disabled" | string;
  countryCodes?: string[];
  voices?: { fish?: string; [engine: string]: string | undefined };
  testing?: { callerVoice?: string; from?: string };
  format?: { numberLocale?: string };
  documents?: Record<string, Record<string, string>>;
  lexicon?: LexiconSource;
  personas?: Record<string, PersonaLines>;
}

export interface LoadedPack extends LocalePack {
  lex: Lexicon;
}
