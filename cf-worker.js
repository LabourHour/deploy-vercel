/**
 * Cloudflare Worker 反向代理 Vercel 脚本（支持 WebSocket 长连接与防 404 伪装）
 * 用途：
 *   由于 *.vercel.app 官方分配的域名在大陆被墙/SNI阻断，
 *   此 Worker 负责在 Cloudflare CDN 边缘接收流量并反向代理回 Vercel 节点。
 * 
 * 关键特性：
 *   1. 完美修正 Host 请求头（避免 Vercel 报 404 错误）
 *   2. 完美传递 Upgrade: websocket 双向长连接
 *   3. 支持多个 Vercel 备用域名轮询与容灾
 */

// ========================== 配置区域 ==========================
// 填写你在 Vercel 上部署成功的域名（不要加 https://，支持填写多个实现轮询容灾）
const VERCEL_DOMAINS = [
  'your-project-name.vercel.app', // <-- 替换为你真实的 Vercel 域名
];

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      
      // 随机选取一个 Vercel 节点域名
      const targetHost = getRandomDomain(VERCEL_DOMAINS);
      
      // 构造转发目标 URL
      const targetUrl = new URL(request.url);
      targetUrl.protocol = 'https:';
      targetUrl.hostname = targetHost;
      targetUrl.port = '443';

      // 复制并修正请求头（至关重要：Vercel 依赖 Host 头定位部署项目）
      const newHeaders = new Headers(request.headers);
      newHeaders.set('Host', targetHost);
      newHeaders.set('X-Forwarded-Host', url.hostname);
      newHeaders.set('X-Real-IP', request.headers.get('cf-connecting-ip') || '');

      // 处理 WebSocket 长连接
      const upgradeHeader = request.headers.get('Upgrade');
      if (upgradeHeader && upgradeHeader.toLowerCase() === 'websocket') {
        return fetch(targetUrl.toString(), {
          method: request.method,
          headers: newHeaders,
          body: request.body
        });
      }

      // 普通 HTTP 请求转发
      const newRequest = new Request(targetUrl.toString(), {
        method: request.method,
        headers: newHeaders,
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
        redirect: 'follow'
      });

      return await fetch(newRequest);
    } catch (err) {
      return new Response(`Proxy Error: ${err.message}`, { status: 502 });
    }
  }
};

function getRandomDomain(domains) {
  if (!domains || domains.length === 0) return 'example.vercel.app';
  const index = Math.floor(Math.random() * domains.length);
  return domains[index].trim();
}
