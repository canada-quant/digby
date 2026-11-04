import axios from 'axios';
import * as fs from 'fs';

// Supports local Docker dev (localhost), Tailscale IP, or explicit override via env var.
// Never hard-code an IP here — use CROSSMODEL_API_URL env var if needed.
const API_URL = process.env.CROSSMODEL_API_URL || 'http://localhost:4000/api';

async function runTests() {
  console.log("Starting tests...");
  // 1. Register a test user
  const email = `test_${Date.now()}@example.com`;
  const password = 'TestPassword123!';
  
  let token = '';
  try {
    const res = await axios.post(`${API_URL}/auth/register`, { name: 'Test User', email, password });
    token = res.data.data.accessToken;
    console.log("Registered user.");
  } catch (e: any) {
    console.error("Register failed:", e.response?.data || e.message);
    return;
  }

  const client = axios.create({
    headers: { Authorization: `Bearer ${token}` },
    baseURL: API_URL
  });

  const questions = [
    { name: 'Simple', q: 'What is 2+2?', webSearch: false },
    { name: 'Medium', q: 'Explain the concept of entropy in information theory.', webSearch: false },
    { name: 'Complex', q: 'What are the current major events happening in global space exploration right now? List specific missions.', webSearch: true },
  ];

  for (const modelSet of ['open_source', 'frontier']) {
    console.log(`\n=== Testing Model Set: ${modelSet} ===`);
    await client.put('/crossmodel/preferences', { modelSet });
    
    for (const mode of ['fast', 'thinking']) {
      console.log(`\n--- Mode: ${mode} ---`);
      
      for (const question of questions) {
        console.log(`\nAsking ${question.name} Question: "${question.q}" (webSearch: ${question.webSearch})`);
        
        try {
          const url = `${API_URL}/crossmodel/stream?message=${encodeURIComponent(question.q)}&mode=${mode}&webSearch=${question.webSearch}&testBypass=true`;
          const response = await axios.get(url, {
            headers: { 
              Authorization: `Bearer ${token}`
            },
            responseType: 'stream'
          });

          let fullData = '';
          let chunkCount = 0;
          await new Promise((resolve, reject) => {
            response.data.on('data', (chunk: Buffer) => {
              const str = chunk.toString();
              fullData += str;
              
              const events = str.match(/data: (.*)\n/g);
              if (events) {
                for (const e of events) {
                  try {
                    const parsed = JSON.parse(e.replace('data: ', '').trim());
                    if (parsed.type === 'chunk') {
                      chunkCount++;
                      if (chunkCount % 10 === 0) process.stdout.write('.');
                    } else if (parsed.type) {
                      process.stdout.write(`[${parsed.type}] `);
                    }
                  } catch (err) {}
                }
              }

              if (fullData.includes('"type":"complete"') || fullData.includes('"type":"error"')) {
                resolve(null);
              }
            });
            response.data.on('end', resolve);
            response.data.on('error', reject);
          });
          
          console.log(`\nFinished streaming. (${chunkCount} chunks)`);
          
          // Check if any errors occurred in the stream
          if (fullData.includes('"type":"error"')) {
            console.error("\nStream contained an error!");
            const errMatch = fullData.match(/data: (.*"type":"error".*)\n/);
            if (errMatch) {
              try {
                console.error("Error payload:", JSON.parse(errMatch[1]));
              } catch (e) {
                console.error("Could not parse error payload:", errMatch[1]);
              }
            }
          } else if (!fullData.includes('"type":"complete"')) {
            console.error("\nStream did not complete properly!");
          } else {
            console.log("\nStream completed successfully.");
            
            // Extract the complete event to verify followUps and summary
            const completeMatch = fullData.match(/data: (.*"type":"complete".*)\n/);
            if (completeMatch) {
              try {
                const completeEvent = JSON.parse(completeMatch[1]);
                const completeData = completeEvent.data;
                console.log(`Summary length: ${completeData.summary?.length}`);
                console.log(`FollowUps: ${completeData.followUps?.length || 0}`);
                if (completeData.models) {
                  console.log("Models responded:");
                  for (const [key, val] of Object.entries(completeData.models)) {
                    const m = val as any;
                    console.log(`- ${key} (${m.modelUsed}): ${m.time}ms, Search: ${m.webSearchUsed}`);
                  }
                }
              } catch (e) {
                console.log("Could not parse complete event data.");
              }
            }
          }
          
        } catch (e: any) {
          console.error("Request failed:", e.message);
        }
      }
    }
  }
}

runTests().catch(console.error);