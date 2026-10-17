// What a parsed JSON body (a Gemini answer, a token response, a locale pack) must be before its
// fields are read: an object, not an array, not null. Fields stay `unknown` until checked.
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
