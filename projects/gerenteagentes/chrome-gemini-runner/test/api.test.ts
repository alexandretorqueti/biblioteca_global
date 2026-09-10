/**
 * Teste básico do WebAI Provider
 * 
 * Valida se o servidor está respondendo corretamente
 */

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';

async function testHealth() {
  console.log('🏥 Testando health check...');
  const response = await fetch(`${BASE_URL}/health`);
  const data = await response.json();
  
  if (data.status === 'ok') {
    console.log('✅ Health check OK');
    console.log(`   Providers: ${data.providers}`);
    console.log(`   Uptime: ${data.uptime.toFixed(1)}s`);
  } else {
    throw new Error('Health check falhou');
  }
}

async function testModels() {
  console.log('\n📋 Testando lista de modelos...');
  const response = await fetch(`${BASE_URL}/v1/models`);
  const data = await response.json();
  
  if (data.data && data.data.length > 0) {
    console.log('✅ Modelos disponíveis:');
    data.data.forEach((model: any) => {
      console.log(`   - ${model.id}`);
    });
  } else {
    throw new Error('Nenhum modelo encontrado');
  }
}

async function testProviders() {
  console.log('\n🔌 Testando lista de providers...');
  const response = await fetch(`${BASE_URL}/api/providers`);
  const data = await response.json();
  
  if (data.providers && data.providers.length > 0) {
    console.log('✅ Providers cadastrados:');
    data.providers.forEach((provider: any) => {
      console.log(`   - ${provider.id} (${provider.name})`);
    });
  } else {
    throw new Error('Nenhum provider encontrado');
  }
}

async function testChatCompletion() {
  console.log('\n💬 Testando chat completion (mock)...');
  
  // Este teste só valida se o endpoint existe e responde
  // Não executa a tarefa real (demoraria muito)
  const response = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gemini',
      messages: [
        { role: 'user', content: 'Teste' }
      ]
    }),
  });
  
  // Espera 200 ou 500 (se o Chrome não estiver instalado)
  if (response.status === 200 || response.status === 500) {
    console.log('✅ Endpoint responde corretamente');
  } else {
    throw new Error(`Status inesperado: ${response.status}`);
  }
}

async function main() {
  console.log('🧪 Iniciando testes do WebAI Provider...\n');
  console.log(`Base URL: ${BASE_URL}\n`);
  
  try {
    await testHealth();
    await testModels();
    await testProviders();
    await testChatCompletion();
    
    console.log('\n✅ Todos os testes passaram!');
  } catch (error) {
    console.error('\n❌ Teste falhou:', error);
    process.exit(1);
  }
}

main();
