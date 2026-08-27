/**
 * The console's shell (Phase 03 follow-up, 2026-08-26).
 *
 * Server-rendered HTML from the Worker: no build step, no framework, no bundle, no client-side routing.
 * That is not minimalism for its own sake - a console for a pilot has to be correct and readable more
 * than it has to be rich, and every dependency added here is one more thing between a stranger and the
 * five screens that decide whether they can use DiffCI at all.
 *
 * The one piece of client-side JavaScript is the action helper below. It exists because DiffCI's API is
 * CSRF-protected by a signed double-submit token (src/auth/csrf.ts), which requires echoing a cookie
 * value in a request HEADER - something a plain HTML form cannot do. Rather than weaken the CSRF check
 * to accept a form field, the console reads the (deliberately non-HttpOnly) CSRF cookie and sends it the
 * way every other API client does. The session cookie stays HttpOnly and is never touched by script.
 *
 * ESCAPING. Everything interpolated into these pages comes from somewhere else: repository names from
 * GitHub, organization names from users. `html` escapes by default and there is no unescaped path - a
 * value that must carry markup has to be built from escaped parts.
 */

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ESCAPES[char]!);
}

/**
 * Tagged template that escapes every interpolated value. Nested `html` results are marked safe by being
 * passed through as `SafeHtml`, so composition works without an "I promise this is fine" escape hatch.
 */
export interface SafeHtml {
  readonly __safeHtml: string;
}

function safe(value: string): SafeHtml {
  return { __safeHtml: value };
}

function isSafe(value: unknown): value is SafeHtml {
  return value !== null && typeof value === "object" && typeof (value as SafeHtml).__safeHtml === "string";
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = "";
  strings.forEach((chunk, index) => {
    out += chunk;
    if (index >= values.length) return;
    const value = values[index];
    if (Array.isArray(value)) {
      out += value.map((item) => (isSafe(item) ? item.__safeHtml : escapeHtml(item))).join("");
    } else if (isSafe(value)) {
      out += value.__safeHtml;
    } else if (value === undefined || value === null || value === false) {
      out += "";
    } else {
      out += escapeHtml(value);
    }
  });
  return safe(out);
}

export function renderSafe(value: SafeHtml): string {
  return value.__safeHtml;
}

const STYLES = `
  :root { color-scheme: light dark; --bg: #fff; --fg: #16181d; --muted: #5b6270; --line: #e3e6ec;
          --accent: #1f6feb; --ok: #1a7f37; --warn: #9a6700; --bad: #b42318; --code-bg: #f6f8fa; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #0d1117; --fg: #e6edf3; --muted: #9198a1; --line: #262c36;
            --accent: #4493f8; --ok: #3fb950; --warn: #d29922; --bad: #f85149; --code-bg: #161b22; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 60rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
  header { border-bottom: 1px solid var(--line); }
  header div { max-width: 60rem; margin: 0 auto; padding: 0.85rem 1.25rem; display: flex; gap: 1rem; align-items: baseline; }
  header strong { letter-spacing: -0.01em; }
  header span { color: var(--muted); font-size: 0.85rem; }
  header a { margin-left: auto; }
  a { color: var(--accent); }
  h1 { font-size: 1.45rem; margin: 0 0 0.35rem; letter-spacing: -0.02em; }
  h2 { font-size: 1.05rem; margin: 2rem 0 0.6rem; }
  p.lede { color: var(--muted); margin: 0 0 1.5rem; }
  table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
  th, td { text-align: left; padding: 0.5rem 0.65rem; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 500; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  pre { background: var(--code-bg); border: 1px solid var(--line); border-radius: 6px; padding: 0.85rem;
        overflow-x: auto; font-size: 0.8rem; line-height: 1.5; }
  code { background: var(--code-bg); padding: 0.1rem 0.3rem; border-radius: 4px; font-size: 0.85em; }
  pre code { background: none; padding: 0; }
  button { font: inherit; padding: 0.4rem 0.8rem; border-radius: 6px; border: 1px solid var(--line);
           background: var(--code-bg); color: var(--fg); cursor: pointer; }
  button:hover { border-color: var(--accent); }
  input { font: inherit; padding: 0.4rem 0.6rem; border-radius: 6px; border: 1px solid var(--line);
          background: var(--bg); color: var(--fg); }
  .row { display: flex; gap: 0.6rem; align-items: center; flex-wrap: wrap; }
  .card { border: 1px solid var(--line); border-radius: 8px; padding: 1rem 1.1rem; margin: 0.75rem 0; }
  .muted { color: var(--muted); }
  .ok { color: var(--ok); } .warn { color: var(--warn); } .bad { color: var(--bad); }
  .notice { border-left: 3px solid var(--warn); padding: 0.5rem 0.85rem; background: var(--code-bg); border-radius: 0 6px 6px 0; }
  .empty { color: var(--muted); font-style: italic; }
  footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--line); color: var(--muted); font-size: 0.82rem; }
`;

/**
 * Sends a JSON request with the CSRF header, then either reloads or shows what came back. Written as a
 * string rather than a module because the console has no build step and this is the whole of its
 * client-side behaviour.
 */
const SCRIPT = `
  function csrfToken() {
    var match = document.cookie.match(/(?:^|; )diffci_csrf=([^;]*)/);
    return match ? decodeURIComponent(match[1]) : "";
  }
  async function act(button) {
    var url = button.dataset.url, method = button.dataset.method || "POST";
    var target = button.dataset.target ? document.getElementById(button.dataset.target) : null;
    var body = button.dataset.body;
    if (button.dataset.confirm && !window.confirm(button.dataset.confirm)) return;
    button.disabled = true;
    try {
      var response = await fetch(url, {
        method: method,
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken() },
        body: method === "GET" ? undefined : (body || "{}"),
        credentials: "same-origin"
      });
      var data = await response.json().catch(function () { return {}; });
      if (!response.ok) {
        if (target) { target.textContent = (data.error || ("request failed (" + response.status + ")")); target.className = "bad"; }
        button.disabled = false;
        return;
      }
      if (target && data.token) {
        // The one value in this product shown exactly once. Nothing stores it, so nothing can show it again.
        target.innerHTML = "";
        var pre = document.createElement("pre");
        pre.textContent = data.token;
        var note = document.createElement("p");
        note.className = "muted";
        note.textContent = "Copy this now - it is not stored and cannot be shown again. Put it in a repository secret named DIFFCI_TOKEN.";
        target.appendChild(pre);
        target.appendChild(note);
        if (data.install && data.install.workflowYaml) {
          var wf = document.createElement("pre");
          wf.textContent = data.install.workflowYaml;
          target.appendChild(wf);
        }
        button.disabled = false;
        return;
      }
      window.location.reload();
    } catch (error) {
      if (target) { target.textContent = String(error); target.className = "bad"; }
      button.disabled = false;
    }
  }
  document.addEventListener("click", function (event) {
    var button = event.target.closest("button[data-url]");
    if (button) { event.preventDefault(); act(button); }
  });
`;

export interface LayoutOptions {
  title: string;
  /** Rendered above the content, e.g. the signed-in user's email. */
  subtitle?: string;
  signedIn?: boolean;
  body: SafeHtml;
}

export function layout(options: LayoutOptions): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(options.title)} — DiffCI</title>
<style>${STYLES}</style>
</head>
<body>
<header><div>
  <strong>DiffCI</strong>
  <span>${escapeHtml(options.subtitle ?? "observation console")}</span>
  ${options.signedIn ? `<a href="/app">Home</a>` : ""}
</div></header>
<main>${renderSafe(options.body)}</main>
<script>${SCRIPT}</script>
</body>
</html>`;
}
