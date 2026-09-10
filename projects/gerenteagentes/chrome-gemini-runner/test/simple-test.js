#!/usr/bin/env node
/**
 * Teste simples — envia "retorne apenas OK" para o WebAI Provider
 */

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';

async function testSimple() {
  console.log('🧪 Teste simples: "retorne apenas OK"\n');
  
  try {
    const response = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gemini',
        messages: [
          { 
            role: 'system', 
            content: 'Você é um executor de terminal. Retorne apenas OK.' 
          },
          { 
            role: 'user', 
            content: 'retorne apenas OK' 
          }
        ]
      }),
    });
    
    console.log(`Status: ${response.status}`);
    const data = await response.json();
    
    if (data.error) {
      console.error('❌ Erro:', data.error.message);
    } else {
      console.log('✅ Resposta:');
      console.log(data.choices[0].message.content);
    }
    
  } catch (error) {
    console.error('❌ Erro na requisição:', error.message);
  }
}

testSimple();
