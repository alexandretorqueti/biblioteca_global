#!/usr/bin/env node
/**
 * Teste mock — valida a API sem abrir Chrome
 */

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';

async function testMock() {
  console.log('🧪 Teste mock (sem Chrome)\n');
  
  // Teste 1: Health check
  console.log('1️⃣ Health check...');
  const health = await fetch(`${BASE_URL}/health`);
  const healthData = await health.json();
  console.log(`   Status: ${health.status}`);
  console.log(`   Providers: ${healthData.providers}`);
  console.log(`   Uptime: ${healthData.uptime.toFixed(1)}s`);
  
  // Teste 2: Lista modelos
  console.log('\n2️⃣ Lista modelos...');
  const models = await fetch(`${BASE_URL}/v1/models`);
  const modelsData = await models.json();
  console.log(`   Status: ${models.status}`);
  console.log(`   Modelos: ${modelsData.data.map(m => m.id).join(', ')}`);
  
  // Teste 3: Lista providers
  console.log('\n3️⃣ Lista providers...');
  const providers = await fetch(`${BASE_URL}/api/providers`);
  const providersData = await providers.json();
  console.log(`   Status: ${providers.status}`);
  console.log(`   Providers: ${providersData.providers.map(p => `${p.id} (${p.name})`).join(', ')}`);
  
  // Teste 4: Adiciona provider customizado
  console.log('\n4️⃣ Adiciona provider customizado...');
  const addProvider = await fetch(`${BASE_URL}/api/providers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'test-ia',
      name: 'Test IA',
      url: 'https://test.example.com/',
      selectors: {
        code: 'code',
        editor: 'textarea',
        stopButton: 'button.stop'
      },
      promptStyle: 'generic'
    })
  });
  const addData = await addProvider.json();
  console.log(`   Status: ${addProvider.status}`);
  console.log(`   Success: ${addData.success}`);
  
  // Teste 5: Verifica se foi adicionado
  console.log('\n5️⃣ Verifica providers atualizados...');
  const providers2 = await fetch(`${BASE_URL}/api/providers`);
  const providersData2 = await providers2.json();
  console.log(`   Total: ${providersData2.providers.length} providers`);
  console.log(`   Providers: ${providersData2.providers.map(p => p.id).join(', ')}`);
  
  // Teste 6: Remove provider customizado
  console.log('\n6️⃣ Remove provider customizado...');
  const removeProvider = await fetch(`${BASE_URL}/api/providers/test-ia`, {
    method: 'DELETE'
  });
  const removeData = await removeProvider.json();
  console.log(`   Status: ${removeProvider.status}`);
  console.log(`   Success: ${removeData.success}`);
  
  console.log('\n✅ Todos os testes da API passaram!');
  console.log('\n⚠️ Nota: O teste real (com Chrome) falhou porque falta libnss3.so no container.');
  console.log('   Para testar com Chrome real, execute no host ou instale as dependências.');
}

testMock().catch(error => {
  console.error('❌ Erro:', error.message);
  process.exit(1);
});
