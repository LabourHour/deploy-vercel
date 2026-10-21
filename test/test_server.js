const http = require('http');
const { WebSocket } = require('ws');

// Configure test environment
process.env.PORT = '3011';
process.env.UUID = '12345678-1234-1234-1234-123456789abc';
process.env.SUB_PATH = 'my-sub';
process.env.NAME = 'TestNode';
process.env.CF_IP = '1.0.0.1';

const server = require('../index.js');

setTimeout(async () => {
  let echoServer = null;
  try {
    // 1. Test root (disguise page)
    const rootRes = await fetch('http://localhost:3011/');
    const rootText = await rootRes.text();
    console.log('[Test 1] Root status:', rootRes.status, 'HTML length:', rootText.length);
    if (!rootText.includes('Green Network') && !rootText.includes('Welcome')) {
      throw new Error('Disguise page content mismatch');
    }

    // 2. Test subscription raw mode
    const subRawRes = await fetch('http://localhost:3011/my-sub?raw=1');
    const subRawText = await subRawRes.text();
    console.log('[Test 2] Sub raw status:', subRawRes.status);

    if (!subRawText.includes('vless://') || !subRawText.includes('trojan://') || !subRawText.includes('ss://')) {
      throw new Error('Missing protocol links in raw output');
    }
    if (!subRawText.includes('1.0.0.1')) {
      throw new Error('Missing preferred IP in output');
    }

    // 3. Test subscription base64 mode
    const subBase64Res = await fetch('http://localhost:3011/my-sub');
    const subBase64Text = await subBase64Res.text();
    const decoded = Buffer.from(subBase64Text.trim(), 'base64').toString('utf8');
    console.log('[Test 3] Base64 decoded matches raw:', decoded.includes('vless://'));
    if (!decoded.includes('vless://')) {
      throw new Error('Base64 decode validation failed');
    }

    // 4. Test custom IP parameter
    const customIpRes = await fetch('http://localhost:3011/my-sub?raw=1&ip=visa.cn');
    const customIpText = await customIpRes.text();
    console.log('[Test 4] Custom IP included:', customIpText.includes('visa.cn'));
    if (!customIpText.includes('visa.cn')) {
      throw new Error('Custom IP parameter failed');
    }

    // 5. Test real VLESS WebSocket Proxy connection to local echo server
    await new Promise((resolve, reject) => {
      echoServer = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('VLESS_ECHO_OK: ' + req.url);
      });

      echoServer.listen(9876, '127.0.0.1', () => {
        const ws = new WebSocket('ws://localhost:3011/12345678');
        const timeout = setTimeout(() => {
          try { ws.close(); } catch (e) { }
          reject(new Error('VLESS WebSocket proxy test timed out'));
        }, 5000);

        ws.on('open', () => {
          // Construct VLESS packet: Version(0) + UUID(16B) + optLen(0) + Cmd(1=TCP) + Port(2B) + Atyp(1=IPv4) + IP(4B) + Payload
          const uuidBuf = Buffer.from('12345678123412341234123456789abc', 'hex');
          const portBuf = Buffer.alloc(2);
          portBuf.writeUInt16BE(9876, 0);
          const ipBuf = Buffer.from([127, 0, 0, 1]);
          const payload = Buffer.from('GET /test-proxy HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');

          const packet = Buffer.concat([
            Buffer.from([0]),     // Version
            uuidBuf,              // UUID
            Buffer.from([0]),     // Opt length
            Buffer.from([1]),     // Cmd: TCP
            portBuf,              // Port
            Buffer.from([1]),     // Atyp: IPv4
            ipBuf,                // IP
            payload               // Initial payload
          ]);
          ws.send(packet);
        });

        let receivedEcho = false;
        ws.on('message', (data) => {
          const str = data.toString('utf8');
          if (str.includes('VLESS_ECHO_OK: /test-proxy')) {
            receivedEcho = true;
            clearTimeout(timeout);
            try { ws.close(); } catch (e) { }
            console.log('[Test 5] VLESS WebSocket proxy verification passed!');
            resolve();
          }
        });

        ws.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });
    });

    // 6. Test VLESS UDP Relay (DNS/UDP Support)
    const dgram = require('dgram');
    let udpEchoServer = null;
    await new Promise((resolve, reject) => {
      udpEchoServer = dgram.createSocket('udp4');
      udpEchoServer.on('message', (msg, rinfo) => {
        udpEchoServer.send(Buffer.from('UDP_ECHO: ' + msg.toString()), rinfo.port, rinfo.address);
      });

      udpEchoServer.bind(9877, '127.0.0.1', () => {
        const ws = new WebSocket('ws://localhost:3011/12345678');
        const timeout = setTimeout(() => {
          try { ws.close(); } catch (e) { }
          reject(new Error('VLESS UDP test timed out'));
        }, 5000);

        ws.on('open', () => {
          const uuidBuf = Buffer.from('12345678123412341234123456789abc', 'hex');
          const portBuf = Buffer.alloc(2);
          portBuf.writeUInt16BE(9877, 0);
          const ipBuf = Buffer.from([127, 0, 0, 1]);
          const udpPayload = Buffer.from('udp-ping');
          const lenBuf = Buffer.alloc(2);
          lenBuf.writeUInt16BE(udpPayload.length, 0);

          const packet = Buffer.concat([
            Buffer.from([0]),     // Version
            uuidBuf,              // UUID
            Buffer.from([0]),     // Opt length
            Buffer.from([2]),     // Cmd: 2 = UDP
            portBuf,              // Port: 9877
            Buffer.from([1]),     // Atyp: 1 = IPv4
            ipBuf,                // 127.0.0.1
            lenBuf,               // 2-byte UDP packet length
            udpPayload            // UDP packet
          ]);
          ws.send(packet);
        });

        ws.on('message', (data) => {
          if (data.toString().includes('UDP_ECHO: udp-ping')) {
            clearTimeout(timeout);
            try { ws.close(); } catch (e) { }
            try { udpEchoServer.close(); } catch (e) { }
            console.log('[Test 6] VLESS WebSocket UDP relay verification passed!');
            resolve();
          }
        });

        ws.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });
    });

    // 7. Test Clash YAML subscription mode (anti-DNS leak & rules verification)
    const clashRes = await fetch('http://localhost:3011/my-sub?clash=1', {
      headers: { 'User-Agent': 'ClashVerge/1.0' }
    });
    const clashYaml = await clashRes.text();
    console.log('[Test 7] Clash YAML status:', clashRes.status, 'YAML length:', clashYaml.length);
    if (!clashYaml.includes('enhanced-mode: fake-ip') ||
        !clashYaml.includes('rule-providers:') ||
        !clashYaml.includes('https://8.8.8.8/dns-query#PROXY') ||
        !clashYaml.includes('RULE-SET,cn_ip,DIRECT')) {
      throw new Error('Clash YAML verification failed: missing key anti-leak or split routing directives');
    }
    console.log('[Test 7] Clash YAML anti-DNS leak & rule-based split routing verification passed!');

    // 8. Test Subscription Metadata & Carrier Matrix in Clash YAML
    const profileTitle = clashRes.headers.get('Profile-Title');
    const subUserinfo = clashRes.headers.get('Subscription-Userinfo');
    const updateInterval = clashRes.headers.get('Profile-Update-Interval');
    const robotsTag = clashRes.headers.get('X-Robots-Tag');

    console.log('[Test 8] Profile-Title:', profileTitle, '| Subscription-Userinfo:', subUserinfo);
    if (!profileTitle || !subUserinfo || updateInterval !== '24' || !robotsTag.includes('noindex')) {
      throw new Error('Missing subscription metadata or security headers');
    }
    if (!clashYaml.includes('🚀 自动选择') ||
        !clashYaml.includes('🇨🇳 移动专选') ||
        !clashYaml.includes('🇨🇳 联通专选') ||
        !clashYaml.includes('🇨🇳 电信专选') ||
        !clashYaml.includes('⚡ 高速选优') ||
        !clashYaml.includes('🌐 原生直连')) {
      throw new Error('Missing carrier-optimized proxy groups in Clash YAML');
    }
    console.log('[Test 8] Subscription headers & Carrier-Optimized Matrix verification passed!');

    console.log('\n>>> ALL AUTOMATED TESTS (HTTP + TCP PROXY + UDP RELAY + CLASH YAML + CARRIER MATRIX + HEADERS) PASSED SUCCESSFULLY! <<<');

    if (echoServer) {
      try { echoServer.close(); } catch (e) { }
    }
    if (server.wss) {
      try { server.wss.close(); } catch (e) { }
    }
    if (server.closeAllConnections) {
      server.closeAllConnections();
    }
    server.close(() => {
      setTimeout(() => process.exit(0), 100);
    });
  } catch (err) {
    console.error('Test error:', err);
    if (echoServer) {
      try { echoServer.close(); } catch (e) { }
    }
    process.exit(1);
  }
}, 1500);
