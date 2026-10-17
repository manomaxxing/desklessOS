// Constant-time comparison of two secrets. Compares the UTF-8 bytes: equal string lengths can
// still be different byte lengths ("é"), which made timingSafeEqual throw (a crash, and a
// length oracle on the admin code).
import { timingSafeEqual } from "node:crypto";

export function safeEqual(a: unknown, b: unknown): boolean {
  const x = Buffer.from(String(a ?? ""), "utf8");
  const y = Buffer.from(String(b ?? ""), "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}
