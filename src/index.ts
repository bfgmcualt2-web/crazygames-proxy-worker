/*
 * Cloudflare Workers Proxy
 * Solves: Mixed Content, Bot Detection, Protocol Issues, Proxy Connection Failures
 */

interface Env {
  TARGET_HOST: string;
  TARGET_SCHEME: string;
  ALLOWED_ASSET_HOSTS: string;
}

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Upgrade-Insecure-Requests": "1",
  Connection: "keep-alive",
};

function sanitizeUrl(url: string): URL | null {
  try {
    const parsed = new URL(url);
    if (!parsed.protocol || !parsed.hostname) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isAllowedAssetHost(host: string | null, targetHost: string, allowedHosts: Set<string>): boolean {
  const lower = String(host || "").toLowerCase();
  if (!lower) return false;

  const normalizedTarget = targetHost.toLowerCase();
  if (lower === normalizedTarget || lower.endsWith(`.${normalizedTarget}`)) return true;

  for (const allowed of allowedHosts) {
    const value = allowed.toLowerCase();
    if (lower === value || lower.endsWith(`.${value}`)) {
      return true;
    }
  }

  return false;
}

function rewriteHtmlAssetUrls(html: string, proxyBaseUrl: string, targetHost: string, allowedHosts: Set<string>): string {
  let rewritten = html;

  rewritten = rewritten.replace(/\b(src|href|srcset)=["']([^"']+)["']/g, (match, attr, url) => {
    const parsed = sanitizeUrl(url);
    if (!parsed) return match;

    if (!isAllowedAssetHost(parsed.hostname, targetHost, allowedHosts)) {
      return match;
    }

    const proxiedUrl = `${proxyBaseUrl}?url=${encodeURIComponent(parsed.toString())}`;
    return `${attr}="${proxiedUrl}"`;
  });

  return rewritten;
}

function buildUpstreamHeaders(request: Request, targetHost: string): Record<string, string> {
  const headers = new Headers(BROWSER_HEADERS);

  const cookie = request.headers.get("cookie");
  if (cookie) headers.set("Cookie", cookie);

  headers.set("Host", targetHost);
  headers.delete("cf-connecting-ip");
  headers.delete("cf-ray");
  headers.delete("cf-visitor");

  return Object.fromEntries(headers);
}

async function proxyRequest(url: URL, request: Request, env: Env): Promise<Response> {
  const upstreamHeaders = buildUpstreamHeaders(request, env.TARGET_HOST);
  const upstreamRequest = new Request(url, {
    method: request.method,
    headers: upstreamHeaders,
    body: request.method !== "GET" && request.method !== "HEAD" ? request.body : null,
  });

  try {
    const response = await fetch(upstreamRequest);
    const contentType = response.headers.get("content-type") || "";
    const isHtml = contentType.includes("text/html");

    if (isHtml) {
      let html = await response.text();
      const allowedHosts = new Set(
        env.ALLOWED_ASSET_HOSTS.split(",")
          .map((x) => x.trim().toLowerCase())
          .filter(Boolean)
      );

      html = rewriteHtmlAssetUrls(html, "/proxy", env.TARGET_HOST, allowedHosts);

      return new Response(html, {
        status: response.status,
        statusText: response.statusText,
        headers: {
          ...Object.fromEntries(response.headers),
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache, no-store, must-revalidate",
        },
      });
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers),
    });
  } catch (error) {
    console.error("Upstream fetch failed:", error);
    return new Response("Gateway Error: Could not reach upstream", {
      status: 502,
      headers: { "Content-Type": "text/plain" },
    });
  }
}

function handleHealth(env: Env): Response {
  return new Response(
    JSON.stringify({
      ok: true,
      target: `${env.TARGET_SCHEME}://${env.TARGET_HOST}`,
      timestamp: new Date().toISOString(),
    }),
    {
      headers: { "Content-Type": "application/json" },
    }
  );
}

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/health") {
    return handleHealth(env);
  }

  if (url.pathname === "/proxy") {
    const rawUrl = url.searchParams.get("url");
    if (!rawUrl) {
      return new Response("Missing ?url= parameter", { status: 400 });
    }

    const target = sanitizeUrl(rawUrl);
    if (!target) {
      return new Response("Invalid URL", { status: 400 });
    }

    const allowedHosts = new Set(
      env.ALLOWED_ASSET_HOSTS.split(",")
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean)
    );

    if (!isAllowedAssetHost(target.hostname, env.TARGET_HOST, allowedHosts)) {
      return new Response("Asset host not allowed", { status: 403 });
    }

    return proxyRequest(target, request, env);
  }

  const targetUrl = new URL(url.pathname + url.search, `${env.TARGET_SCHEME}://${env.TARGET_HOST}`);
  return proxyRequest(targetUrl, request, env);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      console.error("Worker error:", error);
      return new Response("Internal Server Error", { status: 500 });
    }
  },
};
