/** Route read-only analysis events from the unified public DiffCI App to the shadow analyzer. */
export async function forwardReadOnlyWebhook(
  request: Request,
  researchWorker: { fetch(request: Request): Promise<Response> } | undefined,
): Promise<Response | undefined> {
  const event = request.headers.get("X-GitHub-Event");
  if (event !== "push" && event !== "workflow_run") return undefined;
  if (!researchWorker) return Response.json({ ok: false, error: "shadow analysis service is not configured" }, { status: 503 });
  const headers = new Headers();
  for (const name of ["Content-Type", "X-GitHub-Event", "X-GitHub-Delivery", "X-Hub-Signature-256"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return researchWorker.fetch(new Request("https://research.internal/v1/shadow/webhook", {
    method: "POST",
    headers,
    body: await request.arrayBuffer(),
  }));
}
