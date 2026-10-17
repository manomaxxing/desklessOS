// Talking to the server: JSON in, JSON out, errors as ApiError.
// The login is an HttpOnly cookie the server sets; ?token=DEV_TOKEN in the page's URL still
// works for development and is passed on to every request. POSTs are always JSON (the server
// refuses anything else from a cookie session: no forms from other sites).

/** ?token= in the page's URL (development). */
export const devToken = new URLSearchParams(location.search).get("token") ?? "";
export const withDev = (path: string): string =>
  devToken ? `${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(devToken)}` : path;
export const wsUrl = (path: string): string => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${withDev(path)}`;

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}
export const isAbort = (err: unknown): boolean => err instanceof DOMException && err.name === "AbortError";

let unauthorized: (() => void) | null = null;
/** What a 401 does (the admin page: its login form). */
export const onUnauthorized = (fn: () => void): void => { unauthorized = fn; };

export interface RequestOptions {
  signal?: AbortSignal;
  /** Login and invite calls: no dev token, and a 401 is just an answer (wrong password). */
  anonymous?: boolean;
}

async function request<T>(method: "GET" | "POST", path: string, body: unknown, { signal, anonymous = false }: RequestOptions): Promise<T> {
  const res = await fetch(anonymous ? path : withDev(path), {
    method,
    signal,
    headers: method === "POST" ? { "content-type": "application/json" } : {},
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
  });
  const data: unknown = await res.json().catch(() => null);
  signal?.throwIfAborted();
  if (!res.ok) {
    const error = data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : `HTTP ${res.status}`;
    if (res.status === 401 && !anonymous) unauthorized?.();
    throw new ApiError(res.status, error);
  }
  return data as T;
}

export const getJson = <T>(path: string, opts: RequestOptions = {}): Promise<T> => request<T>("GET", path, undefined, opts);
export const postJson = <T>(path: string, body: unknown = {}, opts: RequestOptions = {}): Promise<T> => request<T>("POST", path, body, opts);
/** A path segment from an id (ids can hold "/", "+", "="). */
export const seg = (id: string): string => encodeURIComponent(id);
