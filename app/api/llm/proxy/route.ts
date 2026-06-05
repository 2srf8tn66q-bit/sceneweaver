// 转发到用户配置的 LLM API（沿用 copychat proxy 思路）：
// 浏览器直连第三方 LLM 会有 CORS / 跨域问题，这里在服务端转发一手。
// API Key 由客户端放在 headers 里随请求带过来，不在服务端存储。

export const runtime = "nodejs";

interface ProxyPayload {
  targetUrl?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export async function POST(req: Request) {
  try {
    const { targetUrl, headers, body }: ProxyPayload = await req.json();

    if (!targetUrl) {
      return Response.json({ error: "Missing targetUrl" }, { status: 400 });
    }

    const fetchHeaders: Record<string, string> = { ...(headers ?? {}) };
    delete fetchHeaders["host"];
    delete fetchHeaders["Host"];

    const upstream = await fetch(targetUrl, {
      method: "POST",
      headers: fetchHeaders,
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

    const contentType = upstream.headers.get("content-type") || "";

    // 流式（SSE）：直接把上游 body 透传
    if (contentType.includes("text/event-stream") && upstream.body) {
      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    // 普通 JSON
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { "Content-Type": contentType || "application/json" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    return Response.json({ error: `Proxy error: ${message}` }, { status: 502 });
  }
}
