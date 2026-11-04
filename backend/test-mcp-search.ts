/**
 * Test BrightData MCP web search directly — run on the server inside the container.
 * Usage: npx ts-node test-mcp-search.ts
 */
import axios from 'axios';

const MCP_DIGBY_URL   = 'https://mcp.digby.example.com/mcp';
const MCP_DIGBY_TOKEN = process.env.MCP_DIGBY_TOKEN;

async function testMcpHealth() {
  console.log('\n=== 1. Health Check ===');
  try {
    const start = Date.now();
    const r = await axios.get('https://mcp.digby.example.com/health', { timeout: 10000 });
    console.log(`✅ Health: ${r.data} (${Date.now() - start}ms)`);
  } catch (e: any) {
    console.error(`❌ Health failed: ${e.message}`);
  }
}

async function testMcpToolsList() {
  console.log('\n=== 2. Tools List ===');
  if (!MCP_DIGBY_TOKEN) { console.error('❌ MCP_DIGBY_TOKEN not set'); return; }

  try {
    const start = Date.now();
    const r = await axios.post(MCP_DIGBY_URL,
      { jsonrpc: '2.0', method: 'tools/list', params: {}, id: 1 },
      {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'X-API-Key': MCP_DIGBY_TOKEN,
        },
        timeout: 15000,
        responseType: 'stream',
      }
    );

    await new Promise<void>((resolve) => {
      let buffer = '';
      let done = false;
      const timer = setTimeout(() => {
        if (!done) { done = true; r.data.destroy(); console.log('⚠️  tools/list timed out at 15s'); resolve(); }
      }, 15000);

      r.data.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const raw = trimmed.slice(5).trim();
          if (!raw || raw === '[DONE]') continue;
          try {
            const parsed = JSON.parse(raw);
            if (parsed.id === 1) {
              done = true;
              clearTimeout(timer);
              r.data.destroy();
              const tools = parsed.result?.tools || [];
              console.log(`✅ Tools available (${Date.now() - start}ms): ${tools.length} tools`);
              const searchTool = tools.find((t: any) => t.name === 'search_engine');
              const scrapeTool = tools.find((t: any) => t.name === 'scrape_as_markdown');
              console.log(`   search_engine: ${searchTool ? '✅ exists' : '❌ MISSING'}`);
              console.log(`   scrape_as_markdown: ${scrapeTool ? '✅ exists' : '❌ MISSING'}`);
              resolve();
            }
          } catch {}
        }
      });
      r.data.on('end', () => { if (!done) { done = true; clearTimeout(timer); console.log('⚠️  Stream ended'); resolve(); } });
      r.data.on('error', (e: Error) => { if (!done) { done = true; clearTimeout(timer); console.error('❌ Stream error:', e.message); resolve(); } });
    });
  } catch (e: any) {
    console.error(`❌ tools/list failed: ${e.message}`);
    if (e.response) console.error('   HTTP status:', e.response.status, e.response.statusText);
  }
}

async function testMcpSerp(query: string) {
  console.log(`\n=== 3. SERP Test: "${query}" ===`);
  if (!MCP_DIGBY_TOKEN) { console.error('❌ MCP_DIGBY_TOKEN not set'); return; }

  const requestId = Date.now();
  const start = Date.now();

  try {
    const r = await axios.post(MCP_DIGBY_URL,
      {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'search_engine', arguments: { query, engine: 'google' } },
        id: requestId,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'X-API-Key': MCP_DIGBY_TOKEN,
        },
        timeout: 90000,
        responseType: 'stream',
      }
    );

    console.log(`   POST sent (${Date.now() - start}ms) — waiting for SSE response...`);

    await new Promise<void>((resolve) => {
      let buffer = '';
      let done = false;

      // Log a heartbeat every 5 seconds
      const heartbeat = setInterval(() => {
        if (!done) console.log(`   ⏱  Still waiting... ${Math.round((Date.now() - start) / 1000)}s elapsed`);
      }, 5000);

      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          clearInterval(heartbeat);
          r.data.destroy();
          console.error(`❌ SERP timed out at 90s — no response received`);
          resolve();
        }
      }, 90000);

      r.data.on('data', (chunk: Buffer) => {
        if (done) return;
        const raw = chunk.toString();
        if (buffer.length === 0) {
          console.log(`   First byte received at ${Date.now() - start}ms`);
          console.log(`   First 200 chars: ${raw.substring(0, 200)}`);
        }
        buffer += raw;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const rawJson = trimmed.slice(5).trim();
          if (!rawJson || rawJson === '[DONE]') continue;
          try {
            const parsed = JSON.parse(rawJson);
            if (parsed.id !== requestId) continue;
            done = true;
            clearTimeout(timer);
            clearInterval(heartbeat);
            r.data.destroy();
            if (parsed.error) {
              console.error(`❌ MCP error: ${JSON.stringify(parsed.error)}`);
            } else {
              const content = parsed.result?.content;
              const text = Array.isArray(content) ? content.find((c: any) => c.type === 'text')?.text : null;
              console.log(`✅ SERP success! (${Date.now() - start}ms)`);
              console.log(`   Result length: ${text?.length || 0} chars`);
              console.log(`   First 300 chars: ${(text || '').substring(0, 300)}`);
            }
            resolve();
          } catch {}
        }
      });

      r.data.on('end', () => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          clearInterval(heartbeat);
          console.error(`❌ Stream ended with no result (${Date.now() - start}ms). Buffer: ${buffer.substring(0, 200)}`);
          resolve();
        }
      });

      r.data.on('error', (e: Error) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          clearInterval(heartbeat);
          console.error(`❌ Stream error at ${Date.now() - start}ms: ${e.message}`);
          resolve();
        }
      });
    });
  } catch (e: any) {
    const elapsed = Date.now() - start;
    console.error(`❌ Request failed at ${elapsed}ms: ${e.message}`);
    if (e.response) {
      console.error(`   HTTP status: ${e.response.status}`);
      console.error(`   Headers: ${JSON.stringify(e.response.headers)}`);
    }
    if (e.code) console.error(`   Error code: ${e.code}`);
  }
}

async function main() {
  console.log('🔍 BrightData MCP Diagnostic Test');
  console.log(`   MCP URL: ${MCP_DIGBY_URL}`);
  console.log(`   Token set: ${MCP_DIGBY_TOKEN ? '✅ YES (' + MCP_DIGBY_TOKEN.substring(0, 8) + '...)' : '❌ NO'}`);

  await testMcpHealth();
  await testMcpToolsList();
  await testMcpSerp('what is 2 + 2');
  await testMcpSerp('latest news today');

  console.log('\n✅ Diagnostic complete');
}

main().catch(console.error);
