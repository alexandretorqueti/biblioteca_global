/**
 * Teste do GeminiDirectProvider - HTTP direto sem browser
 */

import { GeminiDirectProvider } from './GeminiDirectProvider.js';

async function main() {
  console.log('🚀 Testando GeminiDirectProvider (HTTP direto)...\n');
  
  const provider = new GeminiDirectProvider('/app/gemini-session.json');
  
  const message = process.argv[2] || 'Responda apenas com a palavra SUCESSO';
  
  console.log(`💬 Mensagem: "${message}"\n`);
  
  const startTime = Date.now();
  const result = await provider.sendMessage(message);
  const duration = Date.now() - startTime;
  
  console.log('\n' + '='.repeat(60));
  console.log(`⏱️  Duração: ${(duration / 1000).toFixed(1)}s`);
  console.log(`✅ Sucesso: ${result.success}`);
  
  if (result.success) {
    console.log(`\n📝 RESPOSTA:\n${result.text}`);
    if (result.reasoning) {
      console.log(`\n🧠 RACIOCÍNIO:\n${result.reasoning.substring(0, 500)}`);
    }
    console.log(`\n🆔 Conversation: ${result.conversationId}`);
    console.log(`🆔 Response: ${result.responseId}`);
  } else {
    console.log(`\n❌ ERRO: ${result.error}`);
    if (result.raw) {
      console.log(`\n📦 Raw response (500 chars):\n${result.raw.substring(0, 500)}`);
    }
  }
  console.log('='.repeat(60));
}

main().catch(console.error);
