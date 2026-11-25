// Use the transport envelope independently of the production client. Tool payloads
// below follow the public API contract, including domain errors delivered over HTTP 200.
export function rpc(init: RequestInit) {
  return JSON.parse(String(init.body)) as { id: string; jsonrpc: string; method: string;
    params: { name: string; arguments: Record<string, unknown>; _meta: Record<string, unknown> } }
}

export function toolResult(init: RequestInit, body: unknown, isError = false): Response {
  return Response.json({ jsonrpc: '2.0', id: rpc(init).id,
    result: { isError, structuredContent: body, content: [{ type: 'text', text: JSON.stringify(body) }] } })
}
