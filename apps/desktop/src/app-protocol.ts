// The app:// scheme the Electron screens load from (V01-R4, spec "API와 preload").
// Never file://: its Origin is "null", which the backend rejects. Built files come
// from the web root with the CSP; /api/ goes to the backend on this same origin, so
// the page needs no CORS and the backend's Origin allowlist holds just APP_ORIGIN.
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

export const APP_SCHEME = "app";
const APP_HOST = "pki";
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

/**
 * Whether `url` is on APP_ORIGIN. Compared by scheme and host: Node's URL gives a
 * non-special scheme the origin "null", Chromium (registered as standard) does not.
 */
export function onAppOrigin(url: unknown): boolean {
  if (typeof url !== "string" || !URL.canParse(url)) return false;
  const { protocol, host } = new URL(url);
  return protocol === `${APP_SCHEME}:` && host === APP_HOST;
}

/** Own-origin scripts, styles and connections only; nothing inline, no frames, no plugins. */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

// What a Vite build emits; anything else is not served.
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

// The page's request headers the API needs; cookies and the rest stay behind.
const FORWARDED = ["authorization", "content-type", "accept"];

export interface AppHandlerOptions {
  /** The built screens (apps/web/dist). */
  webRoot: string;
  /**
   * The running backend's own address, `http://127.0.0.1:<port>`, read per request;
   * undefined once it has exited and until a restarted one is ready (V01-T16). A
   * freed port is open for any local process to bind, so nothing is forwarded there.
   */
  backendUrl: () => string | undefined;
}

const plain = (status: number) => new Response(null, { status });

export function createAppHandler({
  webRoot,
  backendUrl,
}: AppHandlerOptions): (request: Request) => Promise<Response> {
  const root = resolve(webRoot);
  return async (request) => {
    if (!onAppOrigin(request.url)) return plain(403);
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      const target = backendUrl();
      return target === undefined ? plain(502) : forward(request, url, target);
    }
    if (request.method !== "GET" && request.method !== "HEAD") return plain(405);
    return serveFile(root, url.pathname);
  };
}

async function forward(request: Request, url: URL, backendUrl: string): Promise<Response> {
  const headers = new Headers({ origin: APP_ORIGIN });
  for (const name of FORWARDED) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  let res: Response;
  try {
    res = await fetch(`${backendUrl}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      ...(hasBody ? { body: await request.arrayBuffer() } : {}),
    });
  } catch {
    return plain(502);
  }
  return new Response(await res.arrayBuffer(), {
    status: res.status,
    headers: {
      "content-type": res.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
    },
  });
}

async function serveFile(root: string, pathname: string): Promise<Response> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return plain(400);
  }
  const file = resolve(root, `.${decoded === "/" ? "/index.html" : decoded}`);
  const type = TYPES[extname(file)];
  if (!file.startsWith(root + sep) || type === undefined) return plain(404);
  let body: Buffer;
  try {
    body = await readFile(file);
  } catch {
    return plain(404);
  }
  return new Response(new Uint8Array(body), {
    headers: {
      "content-type": type,
      "content-security-policy": CONTENT_SECURITY_POLICY,
      "x-content-type-options": "nosniff",
    },
  });
}
