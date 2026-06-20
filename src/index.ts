const MAX_REDIRECTS = 10;
const REQUEST_TIMEOUT_MS = 10_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

type RedirectHop = {
  url: string;
  status: number;
  statusText: string;
  location: string | null;
  resolvedLocation: string | null;
};

type ResolveResult = {
  inputUrl: string;
  finalUrl: string;
  redirectCount: number;
  reachedLimit: boolean;
  chain: RedirectHop[];
  terminalStatus: number | null;
  terminalStatusText: string | null;
  error: string | null;
};

export default {
  async fetch(request: Request): Promise<Response> {
    const requestUrl = new URL(request.url);

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", {
        status: 405,
        headers: {
          Allow: "GET, HEAD",
        },
      });
    }

    if (requestUrl.pathname === "/api/resolve") {
      return handleApi(requestUrl);
    }

    if (requestUrl.pathname !== "/") {
      return new Response("Not found", { status: 404 });
    }

    return handlePage(requestUrl);
  },
};

async function handleApi(requestUrl: URL): Promise<Response> {
  const rawUrl = requestUrl.searchParams.get("url") ?? "";
  const validation = parseHttpUrl(rawUrl);

  if (!validation.ok) {
    return json(
      {
        error: validation.error,
      },
      400,
    );
  }

  const result = await resolveRedirects(validation.url.href);
  return json(result, result.error ? 502 : 200);
}

async function handlePage(requestUrl: URL): Promise<Response> {
  const rawUrl = requestUrl.searchParams.get("url") ?? "";
  let result: ResolveResult | null = null;
  let formError: string | null = null;

  if (rawUrl.trim() !== "") {
    const validation = parseHttpUrl(rawUrl);

    if (validation.ok) {
      result = await resolveRedirects(validation.url.href);
    } else {
      formError = validation.error;
    }
  }

  return html(renderPage(rawUrl, result, formError));
}

async function resolveRedirects(inputUrl: string): Promise<ResolveResult> {
  const chain: RedirectHop[] = [];
  let currentUrl = inputUrl;
  let terminalStatus: number | null = null;
  let terminalStatusText: string | null = null;
  let error: string | null = null;

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    let response: Response;

    try {
      response = await fetchHeaders(currentUrl);
    } catch (cause) {
      return {
        inputUrl,
        finalUrl: currentUrl,
        redirectCount,
        reachedLimit: false,
        chain,
        terminalStatus,
        terminalStatusText,
        error: cause instanceof Error ? cause.message : "Unable to fetch the next URL.",
      };
    }

    terminalStatus = response.status;
    terminalStatusText = response.statusText;

    const location = response.headers.get("location");
    const isRedirect = REDIRECT_STATUSES.has(response.status) && location !== null;
    const resolvedLocation = isRedirect ? resolveLocation(location, currentUrl) : null;

    chain.push({
      url: currentUrl,
      status: response.status,
      statusText: response.statusText,
      location,
      resolvedLocation,
    });

    if (!isRedirect) {
      return {
        inputUrl,
        finalUrl: currentUrl,
        redirectCount,
        reachedLimit: false,
        chain,
        terminalStatus,
        terminalStatusText,
        error,
      };
    }

    if (resolvedLocation === null) {
      error = "Redirect response included an invalid Location header.";
      return {
        inputUrl,
        finalUrl: currentUrl,
        redirectCount,
        reachedLimit: false,
        chain,
        terminalStatus,
        terminalStatusText,
        error,
      };
    }

    if (redirectCount === MAX_REDIRECTS) {
      return {
        inputUrl,
        finalUrl: resolvedLocation,
        redirectCount: MAX_REDIRECTS,
        reachedLimit: true,
        chain,
        terminalStatus,
        terminalStatusText,
        error: `Stopped after ${MAX_REDIRECTS} redirects.`,
      };
    }

    currentUrl = resolvedLocation;
  }

  return {
    inputUrl,
    finalUrl: currentUrl,
    redirectCount: MAX_REDIRECTS,
    reachedLimit: true,
    chain,
    terminalStatus,
    terminalStatusText,
    error: `Stopped after ${MAX_REDIRECTS} redirects.`,
  };
}

async function fetchHeaders(url: string): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "User-Agent": "Cloudflare-Redirect-Resolver/0.1",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      cf: {
        cacheTtl: 0,
        cacheEverything: false,
      },
    });

    // Cancel the body stream so large pages are not fetched
    if (response.body !== null) {
      await response.body.cancel();
    }
    return response;
  } catch (cause) {
    if (cause instanceof Error && cause.name === "AbortError") {
      throw new Error(`Timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds fetching ${url}.`);
    }

    throw cause;
  } finally {
    clearTimeout(timeoutId);
  }
}

function parseHttpUrl(rawUrl: string):
  | { ok: true; url: URL }
  | { ok: false; error: string } {
  const trimmed = rawUrl.trim();

  if (trimmed === "") {
    return { ok: false, error: "Enter a URL to resolve." };
  }

  let url: URL;

  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: "Enter an absolute URL, including http:// or https://." };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "Only http:// and https:// URLs can be resolved." };
  }

  return { ok: true, url };
}

function resolveLocation(location: string, baseUrl: string): string | null {
  try {
    const url = new URL(location, baseUrl);

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }

    return url.href;
  } catch {
    return null;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function renderPage(rawUrl: string, result: ResolveResult | null, formError: string | null): string {
  const title = "Redirect Resolver";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f7f8fb;
      --panel: #ffffff;
      --text: #1d2433;
      --muted: #606b80;
      --border: #d9dfeb;
      --accent: #1f7a5c;
      --accent-strong: #165944;
      --danger: #b42318;
      --code-bg: #eef2f7;
      --shadow: 0 16px 40px rgb(29 36 51 / 10%);
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #111827;
        --panel: #182132;
        --text: #eef2f7;
        --muted: #aab4c5;
        --border: #354256;
        --accent: #5cc8a4;
        --accent-strong: #89dfc0;
        --danger: #ffb4ab;
        --code-bg: #0f1724;
        --shadow: 0 16px 40px rgb(0 0 0 / 26%);
      }
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
    }

    main {
      width: min(980px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 48px 0;
    }

    header {
      margin-bottom: 28px;
    }

    h1 {
      margin: 0 0 8px;
      font-size: clamp(2rem, 6vw, 4rem);
      line-height: 1;
      letter-spacing: 0;
    }

    p {
      color: var(--muted);
      margin: 0;
      max-width: 720px;
    }

    form,
    .results,
    .notice {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 8px;
      box-shadow: var(--shadow);
    }

    form {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 12px;
      padding: 16px;
      margin-bottom: 20px;
    }

    label {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
    }

    input {
      width: 100%;
      min-width: 0;
      padding: 13px 14px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: transparent;
      color: var(--text);
      font: inherit;
    }

    input:focus {
      outline: 3px solid color-mix(in srgb, var(--accent) 28%, transparent);
      border-color: var(--accent);
    }

    button {
      border: 0;
      border-radius: 6px;
      padding: 0 18px;
      background: var(--accent);
      color: #fff;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
      min-height: 48px;
    }

    button:hover {
      background: var(--accent-strong);
    }

    .notice {
      padding: 16px;
      margin-bottom: 20px;
    }

    .notice.error {
      color: var(--danger);
    }

    .results {
      overflow: hidden;
    }

    .summary {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 1px;
      background: var(--border);
      border-bottom: 1px solid var(--border);
    }

    .summary div {
      background: var(--panel);
      padding: 16px;
      min-width: 0;
    }

    .summary dt {
      color: var(--muted);
      font-size: 0.82rem;
      margin-bottom: 4px;
    }

    .summary dd {
      margin: 0;
      overflow-wrap: anywhere;
      font-weight: 700;
    }

    table {
      width: 100%;
      border-collapse: collapse;
    }

    th,
    td {
      padding: 14px 16px;
      border-bottom: 1px solid var(--border);
      text-align: left;
      vertical-align: top;
    }

    th {
      color: var(--muted);
      font-size: 0.82rem;
      font-weight: 700;
      text-transform: uppercase;
    }

    tr:last-child td {
      border-bottom: 0;
    }

    code {
      display: block;
      max-width: 100%;
      padding: 8px 10px;
      border-radius: 6px;
      background: var(--code-bg);
      color: var(--text);
      overflow-wrap: anywhere;
      white-space: normal;
      font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
      font-size: 0.9rem;
    }

    .status {
      white-space: nowrap;
      font-weight: 700;
    }

    .empty {
      color: var(--muted);
    }

    @media (max-width: 760px) {
      main {
        width: min(100vw - 24px, 980px);
        padding: 28px 0;
      }

      form {
        grid-template-columns: 1fr;
      }

      .summary {
        grid-template-columns: 1fr;
      }

      table,
      thead,
      tbody,
      tr,
      th,
      td {
        display: block;
      }

      thead {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip: rect(0 0 0 0);
      }

      tr {
        border-bottom: 1px solid var(--border);
      }

      tr:last-child {
        border-bottom: 0;
      }

      td {
        border-bottom: 0;
        padding: 10px 16px;
      }

      td::before {
        content: attr(data-label);
        display: block;
        color: var(--muted);
        font-size: 0.76rem;
        font-weight: 700;
        text-transform: uppercase;
        margin-bottom: 4px;
      }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>${title}</h1>
      <p>Paste a URL to trace up to ${MAX_REDIRECTS} redirects. Each hop is requested with GET and the response body is cancelled immediately after headers arrive.</p>
    </header>

    <form method="get" action="/">
      <label for="url">URL</label>
      <input id="url" name="url" type="url" inputmode="url" autocomplete="url" placeholder="https://example.com" value="${escapeHtml(rawUrl)}" required>
      <button type="submit">Resolve</button>
    </form>

    ${formError ? renderNotice(formError, "error") : ""}
    ${result ? renderResult(result) : ""}
  </main>
</body>
</html>`;
}

function renderNotice(message: string, type = ""): string {
  return `<section class="notice ${escapeHtml(type)}">${escapeHtml(message)}</section>`;
}

function renderResult(result: ResolveResult): string {
  const finalLabel = result.reachedLimit ? "Next Location" : "Eventual Location";

  return `<section class="results" aria-live="polite">
    ${result.error ? renderNotice(result.error, "error") : ""}
    <dl class="summary">
      <div>
        <dt>Redirects</dt>
        <dd>${result.redirectCount}${result.reachedLimit ? "+" : ""}</dd>
      </div>
      <div>
        <dt>Terminal Status</dt>
        <dd>${result.terminalStatus === null ? "Unavailable" : `${result.terminalStatus} ${escapeHtml(result.terminalStatusText ?? "")}`}</dd>
      </div>
      <div>
        <dt>${finalLabel}</dt>
        <dd><code>${escapeHtml(result.finalUrl)}</code></dd>
      </div>
    </dl>

    <table>
      <thead>
        <tr>
          <th>Hop</th>
          <th>Status</th>
          <th>Requested URL</th>
          <th>Location Header</th>
          <th>Resolved Location</th>
        </tr>
      </thead>
      <tbody>
        ${result.chain.map(renderHop).join("")}
      </tbody>
    </table>
  </section>`;
}

function renderHop(hop: RedirectHop, index: number): string {
  return `<tr>
    <td data-label="Hop">${index + 1}</td>
    <td data-label="Status" class="status">${hop.status} ${escapeHtml(hop.statusText)}</td>
    <td data-label="Requested URL"><code>${escapeHtml(hop.url)}</code></td>
    <td data-label="Location Header">${hop.location === null ? '<span class="empty">None</span>' : `<code>${escapeHtml(hop.location)}</code>`}</td>
    <td data-label="Resolved Location">${hop.resolvedLocation === null ? '<span class="empty">None</span>' : `<code>${escapeHtml(hop.resolvedLocation)}</code>`}</td>
  </tr>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
