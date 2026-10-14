// One log line per call of log(...). Locally: "HH:MM:SS message". On Cloud Run: one JSON
// object per line, which Cloud Logging parses (severity, message) and makes searchable.

export function createLogger({ format = "text" } = {}) {
  if (format !== "json") return (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);
  return (...args) => {
    const message = args.map(a => (a instanceof Error ? a.stack : typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    const severity = /\berror\b/i.test(message) ? "ERROR" : /\b(failed|refused|lost|warning)\b/i.test(message) ? "WARNING" : "INFO";
    process.stdout.write(`${JSON.stringify({ severity, message })}\n`);
  };
}
