/**
 * Test script to verify web search functionality for all three providers
 */
import axios from 'axios';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GROK_API_KEY = process.env.XAI_GROK_API_KEY;
const GEMINI_API_KEY = process.env.GOOGLE_GEMINI_API_KEY;

async function testOpenAI() {
  console.log('\n=== Testing OpenAI GPT-5.2 with web search ===');
  try {
    const response = await axios.post(
      'https://api.openai.com/v1/responses',
      {
        model: 'gpt-5.2',
        tools: [{ type: 'web_search' }],
        input: 'What is 2+2?',
      },
      {
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );

    console.log('✅ OpenAI Response:', JSON.stringify(response.data, null, 2));
    
    // Try to extract content
    if (Array.isArray(response.data) && response.data.length > 0) {
      const message = response.data[0];
      if (Array.isArray(message.content) && message.content.length > 0) {
        console.log('✅ Extracted text:', message.content[0].text);
      }
    }
  } catch (error: any) {
    console.error('❌ OpenAI Error:', error.response?.data || error.message);
  }
}

async function testGrok() {
  console.log('\n=== Testing Grok with web search ===');
  try {
    const response = await axios.post(
      'https://api.x.ai/v1/responses',
      {
        model: 'grok-4-1-fast',
        input: [
          {
            role: 'user',
            content: 'What is 2+2?',
          },
        ],
        tools: [
          { type: 'web_search' },
          { type: 'x_search' },
        ],
      },
      {
        headers: {
          'Authorization': `Bearer ${GROK_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );

    console.log('✅ Grok Response:', JSON.stringify(response.data, null, 2));
    
    // Try to extract content
    if (Array.isArray(response.data) && response.data.length > 0) {
      const message = response.data[0];
      if (Array.isArray(message.content) && message.content.length > 0) {
        console.log('✅ Extracted text:', message.content[0].text);
      }
    }
  } catch (error: any) {
    console.error('❌ Grok Error:', error.response?.data || error.message);
  }
}

async function testGemini() {
  console.log('\n=== Testing Gemini with web search ===');
  try {
    const model = 'gemini-3-flash-preview:generateContent';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}?key=${GEMINI_API_KEY}`;
    
    const response = await axios.post(
      url,
      {
        contents: [
          {
            parts: [{ text: 'What is 2+2?' }],
          },
        ],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 2048,
        },
        tools: [{ googleSearch: {} }],
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000,
      }
    );

    const content = response.data.candidates?.[0]?.content?.parts?.[0]?.text;
    console.log('✅ Gemini Response:', content);
  } catch (error: any) {
    console.error('❌ Gemini Error:', error.response?.data || error.message);
  }
}

async function main() {
  console.log('🧪 Testing Web Search APIs for CrossModel\n');
  await testOpenAI();
  await testGrok();
  await testGemini();
  console.log('\n✅ All tests complete!');
}

main();
