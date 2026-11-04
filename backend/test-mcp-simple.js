// BrightData MCP SERP diagnostic test - plain JS, no compilation needed
const https = require('https');
const TOKEN = process.env.MCP_DIGBY_TOKEN;
console.log('Token:', TOKEN ? 'YES (' + TOKEN.substring(0,8) + '...)' : 'NO - MISSING!');

function mcpCall(q) {
  return new Promise(function(resolve, reject) {
    var id = Date.now();
    var body = JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'search_engine', arguments: { query: q, engine: 'google' } },
      id: id
    });
    var opts = {
      hostname: 'mcp.digby.example.com',
      path: '/mcp',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'X-API-Key': TOKEN,
        'Content-Length': Buffer.byteLength(body)
      }
    };
    var start = Date.now();
    var hb = setInterval(function() { process.stdout.write('  ' + Math.round((Date.now()-start)/1000) + 's.. '); }, 5000);
    var done = false;
    var buf = '';

    var timer = setTimeout(function() {
      clearInterval(hb);
      req.destroy();
      reject(new Error('90s timeout'));
    }, 90000);

    var req = https.request(opts, function(res) {
      console.log('HTTP', res.statusCode, 'Content-Type:', res.headers['content-type']);
      res.on('data', function(chunk) {
        if (done) return;
        var s = chunk.toString();
        if (!buf) { console.log('First byte at ' + (Date.now()-start) + 'ms. Preview: ' + s.substring(0,200)); }
        buf += s;
        var lines = buf.split('\n');
        buf = lines.pop() || '';
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i].trim();
          if (line.indexOf('data:') !== 0) continue;
          var raw = line.slice(5).trim();
          if (!raw || raw === '[DONE]') continue;
          try {
            var p = JSON.parse(raw);
            if (p.id !== id) continue;
            done = true;
            clearTimeout(timer);
            clearInterval(hb);
            res.destroy();
            if (p.error) { reject(new Error(JSON.stringify(p.error))); return; }
            var c = p.result && p.result.content;
            var t = Array.isArray(c) ? ((c.find(function(x) { return x.type === 'text'; }) || {}).text || null) : null;
            resolve({ ms: Date.now()-start, len: t ? t.length : 0, preview: (t || '').substring(0, 500) });
          } catch(e) {}
        }
      });
      res.on('end', function() {
        if (!done) {
          done = true;
          clearTimeout(timer);
          clearInterval(hb);
          reject(new Error('Stream ended without result. Final buf: ' + buf.substring(0,300)));
        }
      });
    });

    req.on('error', function(e) {
      if (!done) { done = true; clearTimeout(timer); clearInterval(hb); reject(e); }
    });
    req.write(body);
    req.end();
  });
}

async function main() {
  if (!TOKEN) { console.error('ERROR: MCP_DIGBY_TOKEN not set'); process.exit(1); }

  console.log('\n=== Test 1: simple arithmetic query ===');
  try {
    var r = await mcpCall('what is 2 plus 2');
    console.log('SUCCESS! ' + r.ms + 'ms, ' + r.len + ' chars');
    console.log('Preview:\n' + r.preview);
  } catch(e) { console.error('FAILED:', e.message); }

  console.log('\n=== Test 2: news query ===');
  try {
    var r2 = await mcpCall('latest technology news today');
    console.log('SUCCESS! ' + r2.ms + 'ms, ' + r2.len + ' chars');
    console.log('Preview:\n' + r2.preview);
  } catch(e) { console.error('FAILED:', e.message); }

  console.log('\nDone.');
}

main().catch(console.error);
