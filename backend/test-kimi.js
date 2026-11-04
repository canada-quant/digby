// Direct Kimi test via Fireworks AI
// Tests BOTH models used in production:
//   - kimi-k2-instruct-0905 (validator role — fast, non-thinking)
//   - kimi-k2p5 (synthesizer/Digby role — always reasons, streaming only)
//
// NOTE: Together AI was fully removed in Session 33 (Mar 4, 2026).
//       All Kimi calls now go through Fireworks AI (FIREWORKS_API_KEY).

const https = require('https');

const FIREWORKS_KEY = process.env.FIREWORKS_API_KEY;
const FIREWORKS_HOST = 'api.fireworks.ai';
const FIREWORKS_PATH = '/inference/v1/chat/completions';

// Two models in production:
const KIMI_FAST  = 'accounts/fireworks/models/kimi-k2-instruct-0905'; // validator — fast, non-thinking
const KIMI_MODEL = 'accounts/fireworks/models/kimi-k2p5';             // synthesizer — always reasons (streaming)

console.log('FIREWORKS_API_KEY set:', FIREWORKS_KEY ? 'YES (' + FIREWORKS_KEY.substring(0,8) + '...)' : 'NO - MISSING!');

function fireworksQuery(model, message, stream) {
  return new Promise(function(resolve, reject) {
    var payload = {
      model: model,
      messages: [{ role: 'user', content: message }],
      max_tokens: stream ? 512 : 256,
      temperature: 0.6,
      top_p: 0.95,
      stream: !!stream,
    };

    var body = JSON.stringify(payload);
    var opts = {
      hostname: FIREWORKS_HOST,
      path: FIREWORKS_PATH,
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + FIREWORKS_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    var start = Date.now();
    var hb = setInterval(function() {
      process.stdout.write('  ' + Math.round((Date.now()-start)/1000) + 's.. ');
    }, 5000);

    var req = https.request(opts, function(res) {
      var data = '';
      console.log('HTTP', res.statusCode);
      res.on('data', function(chunk) { data += chunk.toString(); });
      res.on('end', function() {
        clearInterval(hb);
        var elapsed = Date.now() - start;

        if (stream) {
          // Parse SSE stream — collect all delta.content tokens
          var content = '';
          var reasoning = '';
          var lines = data.split('\n');
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
            try {
              var parsed = JSON.parse(line.slice(6));
              var delta = parsed.choices && parsed.choices[0] && parsed.choices[0].delta;
              if (delta) {
                if (delta.content) content += delta.content;
                if (delta.reasoning_content) reasoning += delta.reasoning_content;
              }
            } catch(e) { /* skip bad JSON */ }
          }
          resolve({ ms: elapsed, content: content || '(empty)', reasoningLen: reasoning.length });
          return;
        }

        try {
          var parsed2 = JSON.parse(data);
          if (parsed2.error) {
            reject(new Error(JSON.stringify(parsed2.error)));
            return;
          }
          var msg = parsed2.choices && parsed2.choices[0] && parsed2.choices[0].message;
          var content2 = (msg && msg.content) || '';
          var reasoningContent = (msg && (msg.reasoning_content || msg.reasoning)) || '';
          resolve({
            ms: elapsed,
            content: content2 || '(empty)',
            reasoningLen: reasoningContent.length,
            usage: parsed2.usage
          });
        } catch(e) {
          reject(new Error('Parse error: ' + data.substring(0, 300)));
        }
      });
    });

    var timer = setTimeout(function() {
      clearInterval(hb);
      req.destroy();
      reject(new Error('Timed out after 120s'));
    }, 120000);

    req.on('error', function(e) {
      clearInterval(hb);
      clearTimeout(timer);
      reject(e);
    });

    req.on('response', function() { clearTimeout(timer); });

    req.write(body);
    req.end();
  });
}

async function main() {
  if (!FIREWORKS_KEY) {
    console.error('FIREWORKS_API_KEY not set! Export it first:');
    console.error('  export FIREWORKS_API_KEY=<your-key>');
    process.exit(1);
  }

  // ── Test 1: kimi-k2-instruct-0905 (validator, non-streaming) ─────────────
  console.log('\n=== Test 1: kimi-k2-instruct-0905 (validator — non-thinking, non-streaming) ===');
  var t1 = Date.now();
  try {
    var r = await fireworksQuery(KIMI_FAST, 'What is 2 + 2? Be brief.', false);
    console.log('SUCCESS in', r.ms + 'ms');
    console.log('Response:', r.content);
    console.log('Reasoning tokens:', r.reasoningLen || 0);
    if (r.usage) console.log('Usage:', JSON.stringify(r.usage));
  } catch(e) {
    console.error('FAILED after', Math.round((Date.now()-t1)/1000) + 's:', e.message);
  }

  // ── Test 2: kimi-k2p5 (synthesizer, streaming) ───────────────────────────
  console.log('\n=== Test 2: kimi-k2p5 (synthesizer/Digby — always-reasoning, streaming) ===');
  console.log('(This model always generates reasoning tokens first before content — may take 20-60s)');
  var t2 = Date.now();
  try {
    var r2 = await fireworksQuery(KIMI_MODEL, 'What is 2 + 2? Be brief.', true);
    console.log('SUCCESS in', r2.ms + 'ms');
    console.log('Content:', r2.content);
    console.log('Reasoning tokens streamed:', r2.reasoningLen || 0, 'chars (ignored by production code)');
  } catch(e) {
    console.error('FAILED after', Math.round((Date.now()-t2)/1000) + 's:', e.message);
  }

  // ── Test 3: validator with a longer prompt (mimics real validator role) ───
  console.log('\n=== Test 3: kimi-k2-instruct-0905 — validator role with context (non-streaming) ===');
  var t3 = Date.now();
  try {
    var r3 = await fireworksQuery(
      KIMI_FAST,
      '═══ YOUR ROLE: REASONING VALIDATOR ═══\nAnother AI said "2 + 2 = 4". Validate this claim logically and note any edge cases.',
      false
    );
    console.log('SUCCESS in', r3.ms + 'ms');
    console.log('Response (first 200 chars):', r3.content.substring(0, 200));
  } catch(e) {
    console.error('FAILED after', Math.round((Date.now()-t3)/1000) + 's:', e.message);
  }

  console.log('\nDone.');
  console.log('\nSUMMARY:');
  console.log('  kimi-k2-instruct-0905 (validator) → should be 2-20s ✅');
  console.log('  kimi-k2p5 (synthesizer, streaming) → 20-60s is normal (reasoning model) ✅');
}

main().catch(console.error);
