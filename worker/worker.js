/**
 * 脸系血统鉴定 · Cloudflare Worker 代理
 * 作用：隐藏智谱 API Key、解决浏览器跨域、转发到智谱视觉模型
 * 部署后在 Worker → Settings → Variables and Secrets 配置：
 *   ZHIPU_API_KEY = 你的智谱 API Key（类型选 Secret）
 * 可选环境变量：
 *   MODEL          默认 glm-4.6v-flash（免费），可改 glm-4.5v
 *   ALLOWED_ORIGIN 默认 *，建议填你的 GitHub Pages 域名，如 https://chemist599.github.io
 */

const ZHIPU_ENDPOINT = "https://open.bigmodel.cn/api/paas/v4/chat/completions";

// 简单限流：同一 IP 每分钟最多 20 次（基于 isolate 内存，基础防护）
const rateMap = new Map();
function checkRate(ip) {
  const now = Date.now(), window = 60 * 1000, limit = 20;
  const arr = (rateMap.get(ip) || []).filter(t => now - t < window);
  if (arr.length >= limit) { rateMap.set(ip, arr); return false; }
  arr.push(now); rateMap.set(ip, arr); return true;
}

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400"
  };
}

function json(data, status, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(env) }
  });
}

export default {
  async fetch(request, env, ctx) {
    // 跨域预检
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }
    if (request.method !== "POST") {
      return json({ error: "仅支持 POST 请求" }, 405, env);
    }
    if (!env.ZHIPU_API_KEY) {
      return json({ error: "服务未配置 ZHIPU_API_KEY" }, 500, env);
    }

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (!checkRate(ip)) {
      return json({ error: "请求过于频繁，请稍后再试" }, 429, env);
    }

    let payload;
    try {
      payload = await request.json();
    } catch (e) {
      return json({ error: "请求体不是合法 JSON" }, 400, env);
    }
    if (!payload.image || !payload.prompt) {
      return json({ error: "缺少 image 或 prompt 字段" }, 400, env);
    }

    const body = {
      model: env.MODEL || "glm-4.6v-flash",
      response_format: { type: "json_object" },
      temperature: 0.7,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: payload.prompt },
            { type: "image_url", image_url: { url: payload.image } }
          ]
        }
      ]
    };

    let upstream;
    try {
      upstream = await fetch(ZHIPU_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + env.ZHIPU_API_KEY
        },
        body: JSON.stringify(body)
      });
    } catch (e) {
      return json({ error: "无法连接智谱服务" }, 502, env);
    }

    // 透传智谱响应（保留状态码与 CORS 头）
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { "Content-Type": "application/json", ...corsHeaders(env) }
    });
  }
};
