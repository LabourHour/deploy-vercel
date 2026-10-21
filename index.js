#!/usr/bin/env node

/**
 * deploy-vercel - High-Performance Multi-Protocol Serverless Proxy & Subscription Generator
 * Protocols Supported: VLESS (WS), Trojan (WS), Shadowsocks (v2ray-plugin WS)
 * Features:
 *   - Auto Disguise Webpage on /
 *   - Smart Subscription on /${SUB_PATH} (with Base64 & ?raw=1 output)
 *   - Native Cloudflare Clean/Preferred IP (CF_IP) support in subscription
 *   - In-Memory High-Speed DNS TTL Cache with Multi-DoH Fallback
 *   - Full Exception Immunity & Zero-Leak Bidirectional Stream Lifecycles
 *   - Dynamic Domain fallback to req.headers.host (Zero-config startup)
 *   - Lazy-loaded Nezha Agent probe (gRPC) for non-serverless / VPS deployments
 */

const os = require('os');
const http = require('http');
const fs = require('fs');
const net = require('net');
const dgram = require('dgram');
const dns = require('dns');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { Buffer } = require('buffer');
const axios = require('axios');
const { WebSocket, createWebSocketStream } = require('ws');

// ========================== 环境变量与基础配置 ==========================
// 自动生成高强度随机 UUID 或使用配置的 UUID
function generateUUID() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

const DEFAULT_FALLBACK_UUID = 'd1cf4b9c-3e57-085d-b34a-797fcf601381';
const UUID = (process.env.UUID || DEFAULT_FALLBACK_UUID).trim().toLowerCase();
const DOMAIN = (process.env.DOMAIN || '').trim(); // 若留空，自动使用客户端访问时的 Host
const CF_IP = (process.env.CF_IP || process.env.PROXY_IP || '').trim(); // 优选 IP / 优选域名（可选）
const SUB_PATH = (process.env.SUB_PATH || 'vercel').trim().replace(/^\//, ''); // 订阅路径
const NAME = (process.env.NAME || 'Vercel').trim(); // 节点前缀名称
const PORT = parseInt(process.env.PORT || '3000', 10);
const WSPATH = (process.env.WSPATH || UUID.slice(0, 8)).trim().replace(/^\//, ''); // WebSocket 路径

// 哪吒探针配置
const NEZHA_SERVER = (process.env.NEZHA_SERVER || '').trim();
const NEZHA_KEY = (process.env.NEZHA_KEY || '').trim();
const NEZHA_PORT = process.env.NEZHA_PORT ? parseInt(process.env.NEZHA_PORT, 10) : 0;
const AGENT_VERSION = 'nodejs-9.9.9';
const REPORT_DELAY = 4;
const RETRY_DELAY = 10000;
const IP_REPORT_PERIOD = 1800;
const NETWORK_TIMEOUT = 8000;

// 保活与调试
const AUTO_ACCESS = process.env.AUTO_ACCESS === 'true' || process.env.AUTO_ACCESS === '1';
const KEEP_ALIVE_URL = (process.env.KEEP_ALIVE_URL || '').trim();
const SHOW_LOG = !!process.env.SHOW_LOG;

function log(...args) { if (SHOW_LOG) console.log('[Deploy-Vercel]', ...args); }
function logErr(...args) { if (SHOW_LOG) console.error('[Deploy-Vercel ERROR]', ...args); }
function logWarn(...args) { if (SHOW_LOG) console.warn('[Deploy-Vercel WARN]', ...args); }

// 常量与黑名单
const TLS_PORTS = new Set([443, 2053, 2083, 2087, 2096, 8443]);
const BLOCKED_DOMAINS = [
  'speedtest.net', 'fast.com', 'speedtest.cn', 'speed.cloudflare.com', 'speedof.me',
  'testmy.net', 'bandwidth.place', 'speed.io', 'librespeed.org', 'speedcheck.org'
];

function isBlockedDomain(host) {
  if (!host) return false;
  const hostLower = host.toLowerCase();
  return BLOCKED_DOMAINS.some(blocked => hostLower === blocked || hostLower.endsWith('.' + blocked));
}

// ========================== 高性能 DNS 缓存与解析器 ==========================
const dnsCache = new Map(); // host -> { ip, expireAt }
const DNS_CACHE_TTL = 5 * 60 * 1000; // 5分钟

async function resolveHost(host) {
  // 如果已经是 IP 地址，直接返回
  if (net.isIP(host)) {
    return host;
  }

  const now = Date.now();
  const cached = dnsCache.get(host);
  if (cached && cached.expireAt > now) {
    return cached.ip;
  }

  // 1. 优先尝试本地 Node.js DNS 解析（最快，利用系统与云平台本地缓存）
  try {
    const lookup = await dns.promises.lookup(host, { family: 4 });
    if (lookup && lookup.address) {
      dnsCache.set(host, { ip: lookup.address, expireAt: now + DNS_CACHE_TTL });
      return lookup.address;
    }
  } catch (e) {
    // 降级到 DoH
  }

  // 2. 备用：Google DoH
  try {
    const res = await axios.get(`https://dns.google/resolve?name=${encodeURIComponent(host)}&type=A`, {
      timeout: 3000,
      headers: { 'Accept': 'application/dns-json' }
    });
    if (res.data && res.data.Status === 0 && Array.isArray(res.data.Answer)) {
      const record = res.data.Answer.find(r => r.type === 1);
      if (record && record.data) {
        dnsCache.set(host, { ip: record.data, expireAt: now + DNS_CACHE_TTL });
        return record.data;
      }
    }
  } catch (e) { }

  // 3. 备用：Cloudflare DoH
  try {
    const res = await axios.get(`https://1.1.1.1/dns-query?name=${encodeURIComponent(host)}&type=A`, {
      timeout: 3000,
      headers: { 'Accept': 'application/dns-json' }
    });
    if (res.data && res.data.Status === 0 && Array.isArray(res.data.Answer)) {
      const record = res.data.Answer.find(r => r.type === 1);
      if (record && record.data) {
        dnsCache.set(host, { ip: record.data, expireAt: now + DNS_CACHE_TTL });
        return record.data;
      }
    }
  } catch (e) { }

  // 若 DoH 均失败，返回原始 host 让系统底层 socket 处理
  return host;
}

// ========================== 出口 IP 与地理位置缓存 ==========================
let cachedGeo = { isp: '', ip: '', expireAt: 0 };

async function getGeoInfo() {
  const now = Date.now();
  if (cachedGeo.isp && cachedGeo.expireAt > now) {
    return cachedGeo;
  }

  let countryCode = 'SG';
  let org = 'Vercel';
  let ip = '';

  try {
    const res = await axios.get('https://api.ip.sb/geoip', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 3000
    });
    if (res.data) {
      countryCode = res.data.country_code || 'UN';
      org = res.data.isp || res.data.organization || 'Vercel';
      ip = res.data.ip || '';
    }
  } catch (e) {
    try {
      const res2 = await axios.get('http://ip-api.com/json', {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 3000
      });
      if (res2.data) {
        countryCode = res2.data.countryCode || 'UN';
        org = res2.data.org || 'Vercel';
        ip = res2.data.query || '';
      }
    } catch (e2) {
      countryCode = 'WW';
      org = 'Cloud';
    }
  }

  const cleanOrg = org.replace(/[\s\t\r\n]+/g, '_').replace(/[^a-zA-Z0-9_\-]/g, '');
  cachedGeo = {
    isp: `${countryCode}-${cleanOrg}`,
    ip,
    expireAt: now + 30 * 60 * 1000 // 缓存 30 分钟
  };
  return cachedGeo;
}

// ========================== 统一安全 Socket 桥接 ==========================
function bridgeSockets(duplex, remoteSocket, initialData) {
  let isClosed = false;

  const destroyBoth = (err) => {
    if (isClosed) return;
    isClosed = true;
    if (err && SHOW_LOG) logWarn('Socket bridge closed with error:', err.message);
    try { duplex.destroy(); } catch (e) { }
    try { remoteSocket.destroy(); } catch (e) { }
  };

  // 设置 45 秒空闲超时
  remoteSocket.setTimeout(45000, () => {
    destroyBoth(new Error('Remote socket timed out'));
  });

  duplex.on('error', destroyBoth);
  duplex.on('close', destroyBoth);
  duplex.on('end', destroyBoth);

  remoteSocket.on('error', destroyBoth);
  remoteSocket.on('close', destroyBoth);
  remoteSocket.on('end', destroyBoth);

  if (initialData && initialData.length > 0) {
    remoteSocket.write(initialData);
  }

  duplex.pipe(remoteSocket);
  remoteSocket.pipe(duplex);
}

// ========================== 协议处理逻辑 ==========================

// 1. VLESS 处理 (带完整 try...catch 与边界校验)
const cleanUUID = UUID.replace(/-/g, '').toLowerCase();

function handleVlsConnection(ws, msg) {
  try {
    if (msg.length < 18) return false;
    const VERSION = msg[0];

    // 校验 16 字节 UUID
    const id = msg.slice(1, 17);
    const isValidUUID = id.every((v, idx) => v === parseInt(cleanUUID.substr(idx * 2, 2), 16));
    if (!isValidUUID) return false;

    // 解析附加信息与指令
    const optLength = msg[17];
    let offset = 18 + optLength;
    if (msg.length < offset + 4) return false;

    const cmd = msg[offset]; // 0x01 = TCP, 0x02 = UDP
    offset += 1;

    const port = msg.readUInt16BE(offset);
    offset += 2;

    const atyp = msg[offset];
    offset += 1;

    let host = '';
    if (atyp === 1) { // IPv4
      if (msg.length < offset + 4) return false;
      host = msg.slice(offset, offset + 4).join('.');
      offset += 4;
    } else if (atyp === 2) { // Domain
      if (msg.length < offset + 1) return false;
      const domainLen = msg[offset];
      offset += 1;
      if (msg.length < offset + domainLen) return false;
      host = msg.slice(offset, offset + domainLen).toString('utf8');
      offset += domainLen;
    } else if (atyp === 3) { // IPv6
      if (msg.length < offset + 16) return false;
      const ipv6Parts = [];
      for (let k = 0; k < 16; k += 2) {
        ipv6Parts.push(msg.readUInt16BE(offset + k).toString(16));
      }
      host = ipv6Parts.join(':');
      offset += 16;
    } else {
      return false;
    }

    if (isBlockedDomain(host)) {
      ws.close();
      return false;
    }

    // 检查指令类型 (0x01 = TCP, 0x02 = UDP)
    if (cmd === 0x02) {
      handleVlsUdpConnection(ws, host, port, msg.slice(offset), VERSION);
      return true;
    }

    // 回复 VLESS 握手响应包: [VERSION, 0]
    ws.send(new Uint8Array([VERSION, 0]));
    const duplex = createWebSocketStream(ws);
    const initialPayload = msg.slice(offset);

    resolveHost(host)
      .then(resolvedIP => {
        const socket = net.connect({ host: resolvedIP, port }, () => {
          bridgeSockets(duplex, socket, initialPayload);
        });
        socket.on('error', (err) => {
          logWarn(`VLESS TCP connect error to ${host}:${port}:`, err.message);
          try { duplex.destroy(); } catch (e) { }
          try { ws.close(); } catch (e) { }
        });
      })
      .catch(err => {
        const socket = net.connect({ host, port }, () => {
          bridgeSockets(duplex, socket, initialPayload);
        });
        socket.on('error', () => {
          try { duplex.destroy(); } catch (e) { }
          try { ws.close(); } catch (e) { }
        });
      });

    return true;
  } catch (err) {
    logErr('handleVlsConnection error:', err);
    return false;
  }
}

// VLESS UDP 处理 (支持 DNS 查询与实时 UDP 数据包转发)
function handleVlsUdpConnection(ws, host, port, initialPayload, VERSION) {
  try {
    ws.send(new Uint8Array([VERSION, 0]));
    const duplex = createWebSocketStream(ws);
    const udpSocket = dgram.createSocket('udp4');
    let isClosed = false;

    const cleanup = () => {
      if (isClosed) return;
      isClosed = true;
      try { udpSocket.close(); } catch (e) { }
      try { duplex.destroy(); } catch (e) { }
      try { ws.close(); } catch (e) { }
    };

    udpSocket.on('error', (err) => {
      logWarn(`VLESS UDP socket error for ${host}:${port}:`, err.message);
      cleanup();
    });

    // 监听远端 UDP 响应并按 VLESS 规范封包回传给客户端: [2字节大端长度][payload]
    udpSocket.on('message', (msg) => {
      if (isClosed) return;
      try {
        const lenBuf = Buffer.alloc(2);
        lenBuf.writeUInt16BE(msg.length, 0);
        ws.send(Buffer.concat([lenBuf, msg]));
      } catch (e) {
        cleanup();
      }
    });

    let idleTimer = setTimeout(cleanup, 30000);
    const refreshTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(cleanup, 30000);
    };

    resolveHost(host).then(resolvedIP => {
      if (isClosed) return;

      let buffer = initialPayload && initialPayload.length > 0 ? initialPayload : Buffer.alloc(0);

      const processUdpBuffer = () => {
        while (buffer.length >= 2) {
          const packetLen = buffer.readUInt16BE(0);
          if (buffer.length < 2 + packetLen) break;
          const packet = buffer.slice(2, 2 + packetLen);
          buffer = buffer.slice(2 + packetLen);
          refreshTimer();
          udpSocket.send(packet, port, resolvedIP, (err) => {
            if (err) cleanup();
          });
        }
      };

      processUdpBuffer();

      duplex.on('data', chunk => {
        refreshTimer();
        buffer = Buffer.concat([buffer, chunk]);
        processUdpBuffer();
      });

      duplex.on('error', cleanup);
      duplex.on('close', cleanup);
      duplex.on('end', cleanup);
    }).catch(cleanup);
  } catch (err) {
    logErr('handleVlsUdpConnection error:', err);
    try { ws.close(); } catch (e) { }
  }
}

// 2. Trojan 处理
const trojanHexHash = crypto.createHash('sha224').update(UUID).digest('hex');

function handleTrojConnection(ws, msg) {
  try {
    if (msg.length < 58) return false;
    const receivedPasswordHash = msg.slice(0, 56).toString('utf8');
    if (receivedPasswordHash !== trojanHexHash) return false;

    let offset = 56;
    if (msg[offset] === 0x0d && msg[offset + 1] === 0x0a) offset += 2;
    if (msg.length < offset + 4) return false;

    const cmd = msg[offset];
    if (cmd !== 0x01) return false; // 仅支持 CONNECT (0x01)
    offset += 1;

    const atyp = msg[offset];
    offset += 1;

    let host = '';
    if (atyp === 0x01) { // IPv4
      if (msg.length < offset + 4) return false;
      host = msg.slice(offset, offset + 4).join('.');
      offset += 4;
    } else if (atyp === 0x03) { // Domain
      if (msg.length < offset + 1) return false;
      const hostLen = msg[offset];
      offset += 1;
      if (msg.length < offset + hostLen) return false;
      host = msg.slice(offset, offset + hostLen).toString('utf8');
      offset += hostLen;
    } else if (atyp === 0x04) { // IPv6
      if (msg.length < offset + 16) return false;
      const ipv6Parts = [];
      for (let k = 0; k < 16; k += 2) {
        ipv6Parts.push(msg.readUInt16BE(offset + k).toString(16));
      }
      host = ipv6Parts.join(':');
      offset += 16;
    } else {
      return false;
    }

    if (msg.length < offset + 2) return false;
    const port = msg.readUInt16BE(offset);
    offset += 2;

    if (offset + 1 < msg.length && msg[offset] === 0x0d && msg[offset + 1] === 0x0a) {
      offset += 2;
    }

    if (isBlockedDomain(host)) {
      ws.close();
      return false;
    }

    const duplex = createWebSocketStream(ws);
    const initialPayload = offset < msg.length ? msg.slice(offset) : null;

    resolveHost(host)
      .then(resolvedIP => {
        const socket = net.connect({ host: resolvedIP, port }, () => {
          bridgeSockets(duplex, socket, initialPayload);
        });
        socket.on('error', () => {
          try { duplex.destroy(); } catch (e) { }
          try { ws.close(); } catch (e) { }
        });
      })
      .catch(() => {
        const socket = net.connect({ host, port }, () => {
          bridgeSockets(duplex, socket, initialPayload);
        });
        socket.on('error', () => {
          try { duplex.destroy(); } catch (e) { }
          try { ws.close(); } catch (e) { }
        });
      });

    return true;
  } catch (err) {
    logErr('handleTrojConnection error:', err);
    return false;
  }
}

// 3. Shadowsocks (v2ray-plugin) 处理
function handleSsConnection(ws, msg) {
  try {
    if (msg.length < 3) return false;
    let offset = 0;
    const atyp = msg[offset];
    offset += 1;

    let host = '';
    if (atyp === 0x01) { // IPv4
      if (msg.length < offset + 4) return false;
      host = msg.slice(offset, offset + 4).join('.');
      offset += 4;
    } else if (atyp === 0x03) { // Domain
      if (msg.length < offset + 1) return false;
      const hostLen = msg[offset];
      offset += 1;
      if (msg.length < offset + hostLen) return false;
      host = msg.slice(offset, offset + hostLen).toString('utf8');
      offset += hostLen;
    } else if (atyp === 0x04) { // IPv6
      if (msg.length < offset + 16) return false;
      const ipv6Parts = [];
      for (let k = 0; k < 16; k += 2) {
        ipv6Parts.push(msg.readUInt16BE(offset + k).toString(16));
      }
      host = ipv6Parts.join(':');
      offset += 16;
    } else {
      return false;
    }

    if (msg.length < offset + 2) return false;
    const port = msg.readUInt16BE(offset);
    offset += 2;

    if (isBlockedDomain(host)) {
      ws.close();
      return false;
    }

    const duplex = createWebSocketStream(ws);
    const initialPayload = offset < msg.length ? msg.slice(offset) : null;

    resolveHost(host)
      .then(resolvedIP => {
        const socket = net.connect({ host: resolvedIP, port }, () => {
          bridgeSockets(duplex, socket, initialPayload);
        });
        socket.on('error', () => {
          try { duplex.destroy(); } catch (e) { }
          try { ws.close(); } catch (e) { }
        });
      })
      .catch(() => {
        const socket = net.connect({ host, port }, () => {
          bridgeSockets(duplex, socket, initialPayload);
        });
        socket.on('error', () => {
          try { duplex.destroy(); } catch (e) { }
          try { ws.close(); } catch (e) { }
        });
      });

    return true;
  } catch (err) {
    logErr('handleSsConnection error:', err);
    return false;
  }
}

// ========================== HTTP 服务与订阅路由 ==========================
const httpServer = http.createServer(async (req, res) => {
  const reqUrl = req.headers['x-matched-path'] || req.url || '/';
  const urlObj = new URL(reqUrl, `http://${req.headers.host || 'localhost'}`);
  const pathname = urlObj.pathname;

  // 1. 根路径：提供高保真伪装站
  if (pathname === '/' || pathname === '/index.html') {
    const filePath = path.join(__dirname, 'index.html');
    fs.readFile(filePath, 'utf8', (err, content) => {
      if (err) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!DOCTYPE html><html><head><title>Welcome</title></head><body><h1>Server is running</h1></body></html>');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(content);
    });
    return;
  }

  // 2. 订阅路径：生成 VLESS / Trojan / Shadowsocks 节点
  if (pathname === `/${SUB_PATH}`) {
    try {
      const geo = await getGeoInfo();
      const rawMode = urlObj.searchParams.get('raw') === '1' || urlObj.searchParams.get('format') === 'raw';

      // 提取目标域名（优先读取环境变量，其次动态提取当前 Host）
      let currentDomain = DOMAIN;
      if (!currentDomain || currentDomain === 'your-domain.com') {
        const hostHeader = (req.headers.host || '').split(':')[0].trim();
        if (hostHeader && hostHeader !== 'localhost' && !net.isIP(hostHeader)) {
          currentDomain = hostHeader;
        } else if (geo.ip) {
          currentDomain = geo.ip;
        } else {
          currentDomain = 'my-vercel-app.vercel.app';
        }
      }

      // 检查是否有自定义优选 IP 参数
      const queryPreferredIP = urlObj.searchParams.get('ip') || CF_IP;
      const isHttps = req.headers['x-forwarded-proto'] === 'https' || !net.isIP(currentDomain);
      const tlsParam = isHttps ? 'tls' : 'none';
      const ssTlsParam = isHttps ? 'tls;' : '';
      const port = isHttps ? 443 : PORT;

      const nodes = [];
      const nodeTag = NAME ? `${NAME}-${geo.isp}` : geo.isp;

      // 节点 1: 直连节点 (使用当前分配域名)
      const vlsDirect = `vless://${UUID}@${currentDomain}:${port}?encryption=none&security=${tlsParam}&sni=${currentDomain}&fp=chrome&type=ws&host=${currentDomain}&path=%2F${WSPATH}#${encodeURIComponent(nodeTag)}`;
      const troDirect = `trojan://${UUID}@${currentDomain}:${port}?security=${tlsParam}&sni=${currentDomain}&fp=chrome&type=ws&host=${currentDomain}&path=%2F${WSPATH}#${encodeURIComponent(nodeTag)}`;
      const ssPassword = Buffer.from(`none:${UUID}`).toString('base64');
      const ssDirect = `ss://${ssPassword}@${currentDomain}:${port}?plugin=v2ray-plugin;mode%3Dwebsocket;host%3D${currentDomain};path%3D%2F${WSPATH};${ssTlsParam}sni%3D${currentDomain};skip-cert-verify%3Dtrue;mux%3D0#${encodeURIComponent(nodeTag)}`;

      nodes.push(vlsDirect, troDirect, ssDirect);

      // 节点 2: 如果配置了优选 IP / 域名，自动附带 CDN 优选加速节点
      if (queryPreferredIP) {
        const preferredTag = `[优选CDN] ${nodeTag}`;
        const vlsPreferred = `vless://${UUID}@${queryPreferredIP}:${port}?encryption=none&security=${tlsParam}&sni=${currentDomain}&fp=chrome&type=ws&host=${currentDomain}&path=%2F${WSPATH}#${encodeURIComponent(preferredTag)}`;
        const troPreferred = `trojan://${UUID}@${queryPreferredIP}:${port}?security=${tlsParam}&sni=${currentDomain}&fp=chrome&type=ws&host=${currentDomain}&path=%2F${WSPATH}#${encodeURIComponent(preferredTag)}`;
        const ssPreferred = `ss://${ssPassword}@${queryPreferredIP}:${port}?plugin=v2ray-plugin;mode%3Dwebsocket;host%3D${currentDomain};path%3D%2F${WSPATH};${ssTlsParam}sni%3D${currentDomain};skip-cert-verify%3Dtrue;mux%3D0#${encodeURIComponent(preferredTag)}`;
        nodes.push(vlsPreferred, troPreferred, ssPreferred);
      }

      const isClash = urlObj.searchParams.get('clash') === '1' ||
                      urlObj.searchParams.get('format') === 'clash' ||
                      (req.headers['user-agent'] || '').toLowerCase().includes('clash') ||
                      (req.headers['user-agent'] || '').toLowerCase().includes('mihomo');

      if (isClash) {
        const vlessName = `${nodeTag}-VLESS`;
        const trojanName = `${nodeTag}-Trojan`;
        const proxyNames = [vlessName, trojanName];

        let proxiesYaml = `  - name: "${vlessName}"\n    type: vless\n    server: "${currentDomain}"\n    port: ${port}\n    uuid: "${UUID}"\n    network: ws\n    tls: ${isHttps}\n    udp: true\n    sni: "${currentDomain}"\n    ws-opts:\n      path: "/${WSPATH}"\n      headers:\n        Host: "${currentDomain}"\n  - name: "${trojanName}"\n    type: trojan\n    server: "${currentDomain}"\n    port: ${port}\n    password: "${UUID}"\n    network: ws\n    sni: "${currentDomain}"\n    udp: true\n    ws-opts:\n      path: "/${WSPATH}"\n      headers:\n        Host: "${currentDomain}"`;

        if (queryPreferredIP) {
          const prefVlsName = `[优选CDN] ${nodeTag}-VLESS`;
          const prefTroName = `[优选CDN] ${nodeTag}-Trojan`;
          proxyNames.push(prefVlsName, prefTroName);
          proxiesYaml += `\n  - name: "${prefVlsName}"\n    type: vless\n    server: "${queryPreferredIP}"\n    port: ${port}\n    uuid: "${UUID}"\n    network: ws\n    tls: ${isHttps}\n    udp: true\n    sni: "${currentDomain}"\n    ws-opts:\n      path: "/${WSPATH}"\n      headers:\n        Host: "${currentDomain}"\n  - name: "${prefTroName}"\n    type: trojan\n    server: "${queryPreferredIP}"\n    port: ${port}\n    password: "${UUID}"\n    network: ws\n    sni: "${currentDomain}"\n    udp: true\n    ws-opts:\n      path: "/${WSPATH}"\n      headers:\n        Host: "${currentDomain}"`;
        }

        const proxyList = proxyNames.map(name => `      - "${name}"`).join('\n');
        const directServerRule = net.isIP(currentDomain)
          ? `  - IP-CIDR,${currentDomain}/32,DIRECT,no-resolve`
          : `  - DOMAIN,${currentDomain},DIRECT`;

        const clashYaml = `port: 7890
socks-port: 7891
allow-lan: true
mode: rule
log-level: info
ipv6: false
external-controller: 127.0.0.1:9090
find-process-mode: strict

sniffer:
  enable: true
  override-destination: false
  force-dns-mapping: false
  parse-pure-ip: true
  sniff:
    HTTP:
      ports:
      - 80
      - 8080-8880
    TLS:
      ports:
      - 443
      - 8443
    QUIC:
      ports:
      - 443
      - 8443
  skip-domain:
  - Mijia Cloud
  - +.push.apple.com

dns:
  enable: true
  cache-algorithm: arc
  listen: 0.0.0.0:53
  ipv6: false
  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.1/16
  fake-ip-filter-mode: blacklist
  fake-ip-filter:
  - rule-set:fakeipfilter_cn
  - rule-set:fakeipfilter_!cn
  - rule-set:private_domain
  - rule-set:cn_domain
  - rule-set:microsoftcn_domain
  - rule-set:applecn_domain
  - rule-set:steamcn_domain
  default-nameserver:
  - 223.5.5.5
  - 119.29.29.29
  proxy-server-nameserver:
  - https://dns.alidns.com/dns-query
  - https://doh.pub/dns-query
  direct-nameserver:
  - https://dns.alidns.com/dns-query
  - https://doh.pub/dns-query
  nameserver-policy:
    rule-set:cn_domain,private_domain,fakeipfilter_cn,steamcn_domain,microsoftcn_domain,applecn_domain:
    - https://dns.alidns.com/dns-query#disable-qtype-65=true
    - https://doh.pub/dns-query#disable-qtype-65=true
    rule-set:fakeipfilter_!cn:
    - https://8.8.8.8/dns-query#PROXY&disable-qtype-65=true
  nameserver:
  - https://8.8.8.8/dns-query#PROXY&ecs=223.5.5.0/24
  fallback:
  - https://8.8.8.8/dns-query#PROXY
  fallback-filter:
    geoip: true
    geoip-code: CN
    ipcidr:
    - 240.0.0.0/4

proxies:
${proxiesYaml}

proxy-groups:
  - name: PROXY
    type: select
    proxies:
      - AUTO
${proxyList}
      - DIRECT
  - name: AUTO
    type: url-test
    proxies:
${proxyList}
    url: http://www.gstatic.com/generate_204
    interval: 300
    tolerance: 50

rule-providers:
  reject:
    type: http
    behavior: domain
    url: https://raw.githubusercontent.com/Loyalsoldier/clash-rules/release/reject.txt
    path: ./ruleset/reject.yaml
    interval: 86400
  private:
    type: http
    behavior: domain
    url: https://raw.githubusercontent.com/Loyalsoldier/clash-rules/release/private.txt
    path: ./ruleset/private.yaml
    interval: 86400
  direct:
    type: http
    behavior: domain
    url: https://raw.githubusercontent.com/Loyalsoldier/clash-rules/release/direct.txt
    path: ./ruleset/direct.yaml
    interval: 86400
  proxy:
    type: http
    behavior: domain
    url: https://raw.githubusercontent.com/Loyalsoldier/clash-rules/release/proxy.txt
    path: ./ruleset/proxy.yaml
    interval: 86400
  gfw:
    type: http
    behavior: domain
    url: https://raw.githubusercontent.com/Loyalsoldier/clash-rules/release/gfw.txt
    path: ./ruleset/gfw.yaml
    interval: 86400
  fakeipfilter_cn:
    type: http
    interval: 86400
    behavior: domain
    format: text
    url: https://raw.githubusercontent.com/qichiyuhub/rule/refs/heads/main/rules/fakeipfilter-cn.list
  fakeipfilter_!cn:
    type: http
    interval: 86400
    behavior: domain
    format: text
    url: https://raw.githubusercontent.com/qichiyuhub/rule/refs/heads/main/rules/fakeipfilter-!cn.list
  cn_domain:
    type: http
    interval: 86400
    behavior: domain
    format: mrs
    url: https://github.com/MetaCubeX/meta-rules-dat/raw/refs/heads/meta/geo/geosite/cn.mrs
  cn!_domain:
    type: http
    interval: 86400
    behavior: domain
    format: mrs
    url: https://github.com/MetaCubeX/meta-rules-dat/raw/refs/heads/meta/geo/geosite/geolocation-!cn.mrs
  private_domain:
    type: http
    interval: 86400
    behavior: domain
    format: mrs
    url: https://github.com/MetaCubeX/meta-rules-dat/raw/refs/heads/meta/geo/geosite/private.mrs
  microsoftcn_domain:
    type: http
    interval: 86400
    behavior: domain
    format: mrs
    url: https://github.com/MetaCubeX/meta-rules-dat/raw/refs/heads/meta/geo/geosite/microsoft@cn.mrs
  applecn_domain:
    type: http
    interval: 86400
    behavior: domain
    format: mrs
    url: https://github.com/MetaCubeX/meta-rules-dat/raw/refs/heads/meta/geo/geosite/apple@cn.mrs
  steamcn_domain:
    type: http
    interval: 86400
    behavior: domain
    format: mrs
    url: https://github.com/MetaCubeX/meta-rules-dat/raw/refs/heads/meta/geo/geosite/steam@cn.mrs
  private_ip:
    type: http
    interval: 86400
    behavior: ipcidr
    format: mrs
    url: https://github.com/MetaCubeX/meta-rules-dat/raw/refs/heads/meta/geo/geoip/private.mrs
  google_ip:
    type: http
    interval: 86400
    behavior: ipcidr
    format: mrs
    url: https://github.com/MetaCubeX/meta-rules-dat/raw/refs/heads/meta/geo/geoip/google.mrs
  cn_ip:
    type: http
    interval: 86400
    behavior: ipcidr
    format: mrs
    url: https://github.com/MetaCubeX/meta-rules-dat/raw/refs/heads/meta/geo/geoip/cn.mrs
  applications:
    type: http
    behavior: classical
    url: https://raw.githubusercontent.com/Loyalsoldier/clash-rules/release/applications.txt
    path: ./ruleset/applications.yaml
    interval: 86400

rules:
${directServerRule}
  - AND,((RULE-SET,cn!_domain),(DST-PORT,443),(NETWORK,UDP)),REJECT
  - RULE-SET,applications,DIRECT
  - RULE-SET,private,DIRECT,no-resolve
  - RULE-SET,reject,REJECT
  - RULE-SET,direct,DIRECT
  - RULE-SET,proxy,PROXY
  - RULE-SET,gfw,PROXY
  - RULE-SET,cn!_domain,PROXY
  - RULE-SET,private_ip,DIRECT,no-resolve
  - RULE-SET,google_ip,PROXY
  - RULE-SET,cn_ip,DIRECT
  - GEOIP,CN,DIRECT
  - MATCH,PROXY
`;

        res.writeHead(200, {
          'Content-Type': 'text/yaml; charset=utf-8',
          'Content-Disposition': 'inline; filename="clash.yaml"',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(clashYaml);
        return;
      }

      const subscriptionContent = nodes.join('\n');

      if (rawMode) {
        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(subscriptionContent + '\n');
      } else {
        const base64Content = Buffer.from(subscriptionContent).toString('base64');
        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(base64Content + '\n');
      }
    } catch (err) {
      logErr('Subscription generation failed:', err);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Failed to generate subscription\n');
    }
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found\n');
});

// ========================== WebSocket 挂载 ==========================
const wss = new WebSocket.Server({ server: httpServer });

wss.on('connection', (ws, req) => {
  const url = req.headers['x-matched-path'] || req.url || '';
  const expectedPath = `/${WSPATH}`;

  if (!url.startsWith(expectedPath)) {
    ws.close(1008, 'Invalid Path');
    return;
  }

  // 15 秒首包超时检查
  const handshakeTimer = setTimeout(() => {
    try { ws.close(); } catch (e) { }
  }, 15000);

  ws.once('message', msg => {
    clearTimeout(handshakeTimer);

    // 协议识别与分发
    if (msg.length > 17 && msg[0] === 0) {
      if (handleVlsConnection(ws, msg)) return;
    }
    if (msg.length >= 58) {
      if (handleTrojConnection(ws, msg)) return;
    }
    if (msg.length > 0 && (msg[0] === 0x01 || msg[0] === 0x03 || msg[0] === 0x04)) {
      if (handleSsConnection(ws, msg)) return;
    }

    try { ws.close(); } catch (e) { }
  }).on('error', () => {
    clearTimeout(handshakeTimer);
    try { ws.close(); } catch (e) { }
  });
});

// ========================== 安全保活任务 ==========================
function setupKeepAlive() {
  if (!AUTO_ACCESS || !KEEP_ALIVE_URL) return;

  // 绝不上报敏感的 SUB_PATH 或节点凭证，仅请求伪装根目录
  const pingUrl = KEEP_ALIVE_URL;
  log('Starting keep-alive scheduler to:', pingUrl);

  const timer = setInterval(async () => {
    try {
      await axios.get(pingUrl, { timeout: 10000 });
      log('Keep-alive ping sent successfully');
    } catch (e) {
      logWarn('Keep-alive ping failed:', e.message);
    }
  }, 10 * 60 * 1000); // 每 10 分钟一次
  timer.unref();
}

// ========================== 哪吒探针客户端 (按需懒加载) ==========================
async function startNezhaAgent() {
  if (!NEZHA_SERVER || !NEZHA_KEY) {
    log('Nezha Agent credentials not configured, skipping probe initialization.');
    return;
  }

  // 动态懒加载哪吒依赖，避免无配置时增加启动耗时与内存开销
  try {
    const grpc = require('@grpc/grpc-js');
    const protoLoader = require('@grpc/proto-loader');
    const si = require('systeminformation');

    const PROTO_CONTENT = `
syntax = "proto3";
option go_package = "./proto";
package proto;

service NezhaService {
  rpc ReportSystemState(stream State) returns (stream Receipt) {}
  rpc ReportSystemInfo(Host) returns (Receipt) {}
  rpc RequestTask(stream TaskResult) returns (stream Task) {}
  rpc IOStream(stream IOStreamData) returns (stream IOStreamData) {}
  rpc ReportGeoIP(GeoIP) returns (GeoIP) {}
  rpc ReportSystemInfo2(Host) returns (Uint64Receipt) {}
}

message Host {
  string platform = 1;
  string platform_version = 2;
  repeated string cpu = 3;
  uint64 mem_total = 4;
  uint64 disk_total = 5;
  uint64 swap_total = 6;
  string arch = 7;
  string virtualization = 8;
  uint64 boot_time = 9;
  string version = 10;
  repeated string gpu = 11;
}

message State {
  double cpu = 1;
  uint64 mem_used = 2;
  uint64 swap_used = 3;
  uint64 disk_used = 4;
  uint64 net_in_transfer = 5;
  uint64 net_out_transfer = 6;
  uint64 net_in_speed = 7;
  uint64 net_out_speed = 8;
  uint64 uptime = 9;
  double load1 = 10;
  double load5 = 11;
  double load15 = 12;
  uint64 tcp_conn_count = 13;
  uint64 udp_conn_count = 14;
  uint64 process_count = 15;
  repeated State_SensorTemperature temperatures = 16;
  repeated double gpu = 17;
}

message State_SensorTemperature {
  string name = 1;
  double temperature = 2;
}

message Task {
  uint64 id = 1;
  uint64 type = 2;
  string data = 3;
}

message TaskResult {
  uint64 id = 1;
  uint64 type = 2;
  float delay = 3;
  string data = 4;
  bool successful = 5;
}

message Receipt { bool proced = 1; }
message Uint64Receipt { uint64 data = 1; }
message IOStreamData { bytes data = 1; }

message GeoIP {
  bool use6 = 1;
  IP ip = 2;
  string country_code = 3;
  uint64 dashboard_boot_time = 4;
}

message IP {
  string ipv4 = 1;
  string ipv6 = 2;
}
`;

    const tmpFile = path.join(os.tmpdir(), `nezha_${process.pid}.proto`);
    fs.writeFileSync(tmpFile, PROTO_CONTENT);
    let protoDescriptor;
    try {
      const packageDefinition = protoLoader.loadSync(tmpFile, {
        keepCase: false, longs: Number, enums: Number, defaults: true, oneofs: true,
      });
      protoDescriptor = grpc.loadPackageDefinition(packageDefinition);
    } finally {
      try { fs.unlinkSync(tmpFile); } catch (e) { }
    }

    const proto = protoDescriptor.proto;
    const parts = NEZHA_SERVER.split(':');
    const port = parts.length > 1 ? parseInt(parts[parts.length - 1], 10) : 0;
    const useTLS = TLS_PORTS.has(port);
    const credentials = useTLS ? grpc.credentials.createSsl() : grpc.credentials.createInsecure();

    const metadata = new grpc.Metadata();
    metadata.add('client-secret', NEZHA_KEY);
    metadata.add('client-uuid', UUID);
    metadata.add('client_secret', NEZHA_KEY);
    metadata.add('client_uuid', UUID);

    const client = new proto.NezhaService(NEZHA_SERVER, credentials);
    console.log('[Nezha] Agent initialized connecting to:', NEZHA_SERVER);

    // 简单上报基本系统信息
    const memTotal = os.totalmem();
    const bootTime = Math.floor(Date.now() / 1000 - os.uptime());
    const hostInfo = {
      platform: os.platform(),
      platformVersion: os.release(),
      cpu: [`${os.cpus()[0] ? os.cpus()[0].model : 'vCPU'} ${os.cpus().length} Cores`],
      memTotal,
      diskTotal: 10 * 1024 * 1024 * 1024,
      swapTotal: 0,
      arch: os.arch(),
      virtualization: 'serverless',
      bootTime,
      version: AGENT_VERSION,
      gpu: []
    };

    client.ReportSystemInfo2(hostInfo, metadata, (err, receipt) => {
      if (err) {
        logWarn('[Nezha] ReportSystemInfo2 failed:', err.message);
      } else {
        log('[Nezha] System info reported successfully');
      }
    });
  } catch (err) {
    logWarn('[Nezha] Failed to start Nezha probe:', err.message);
  }
}

// ========================== 服务启动 ==========================
if (require.main === module || !process.env.VERCEL) {
  if (!httpServer.listening) {
    httpServer.listen(PORT, () => {
      console.log(`[Deploy-Vercel] Server is listening on port ${PORT}`);
      console.log(`[Deploy-Vercel] Disguise URL: http://localhost:${PORT}/`);
      console.log(`[Deploy-Vercel] Subscription URL: http://localhost:${PORT}/${SUB_PATH}`);
      console.log(`[Deploy-Vercel] WebSocket Endpoint: ws://localhost:${PORT}/${WSPATH}`);
      
      if (UUID === DEFAULT_FALLBACK_UUID) {
        console.warn(`[Deploy-Vercel WARNING] 当前正使用默认公共 UUID (${UUID})！建议在 Vercel 环境变量中配置您专属的 UUID 以确保安全。`);
      }

      setupKeepAlive();
      startNezhaAgent().catch(err => logWarn('Nezha agent error:', err));
    });
  }
}

// 挂载 wss 对象供外部测试或清理
httpServer.wss = wss;

// 兼容 Vercel Serverless Function 导出
module.exports = httpServer;
