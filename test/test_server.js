const http = require('http');

// Start server
process.env.PORT = '3011';
process.env.UUID = '12345678-1234-1234-1234-123456789abc';
process.env.SUB_PATH = 'my-sub';
process.env.NAME = 'TestNode';
process.env.CF_IP = '1.0.0.1';

const server = require('../index.js');

setTimeout(async () => {
  try {
    // 1. Test root (disguise)
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
    console.log('[Test 2] Sub raw lines:\n' + subRawText.trim());

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

    // 4. Test custom IP parameter
    const customIpRes = await fetch('http://localhost:3011/my-sub?raw=1&ip=visa.cn');
    const customIpText = await customIpRes.text();
    console.log('[Test 4] Custom IP included:', customIpText.includes('visa.cn'));

    console.log('\n>>> ALL AUTOMATED TESTS PASSED SUCCESSFULLY! <<<');
    server.close(() => {
      process.exit(0);
    });
  } catch (err) {
    console.error('Test error:', err);
    process.exit(1);
  }
}, 1500);
