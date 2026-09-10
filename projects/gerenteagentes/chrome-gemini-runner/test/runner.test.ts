/**
 * Teste manual do ChromeGeminiRunner
 * 
 * Executa uma tarefa simples: criar um arquivo README.md
 */

import { ChromeGeminiRunner } from '../src/index.js';

async function main() {
  console.log('🧪 Iniciando teste do ChromeGeminiRunner...\n');
  
  const runner = new ChromeGeminiRunner({
    headless: false,  // Visível para debugar
    taskTimeoutMs: 5 * 60 * 1000,  // 5 minutos (teste rápido)
    commandTimeoutMs: 30 * 1000,   // 30 segundos por comando
    pollIntervalMs: 5 * 1000,      // 5 segundos entre polls
  });
  
  const project = {
    name: 'Projeto Teste',
    repoPath: '/tmp/teste-gemini',
    stack: 'Node.js + TypeScript',
    documentation: 'Este é um projeto de teste para validar o ChromeGeminiRunner.',
  };
  
  const task = {
    id: 'test-001',
    description: 'Criar um arquivo README.md com o título "Projeto Teste" e uma breve descrição.',
    scope: 'Criar apenas o arquivo README.md na raiz do projeto.',
    successCriteria: 'O arquivo README.md deve existir e conter o título "Projeto Teste".',
  };
  
  // Cria o diretório de teste
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);
  await execAsync(`mkdir -p ${project.repoPath}`);
  
  console.log('📂 Diretório de teste criado:', project.repoPath);
  console.log('🚀 Iniciando execução...\n');
  
  const result = await runner.execute(project, task);
  
  console.log('\n📊 Resultado:');
  console.log('   Sucesso:', result.success);
  console.log('   Comandos executados:', result.commandsExecuted.length);
  console.log('   Duração total:', (result.totalDurationMs / 1000).toFixed(1), 's');
  
  if (result.error) {
    console.log('   Erro:', result.error);
  }
  
  console.log('\n📝 Comandos:');
  result.commandsExecuted.forEach((cmd, i) => {
    console.log(`   ${i + 1}. ${cmd.command}`);
    console.log(`      Exit: ${cmd.exitCode} | Duração: ${cmd.durationMs}ms`);
  });
  
  // Verifica se o arquivo foi criado
  try {
    const fs = await import('fs');
    const readme = fs.readFileSync(`${project.repoPath}/README.md`, 'utf-8');
    console.log('\n✅ README.md criado com sucesso:');
    console.log(readme);
  } catch (error) {
    console.log('\n❌ README.md não encontrado');
  }
  
  console.log('\n🏁 Teste concluído');
}

main().catch(error => {
  console.error('❌ Erro no teste:', error);
  process.exit(1);
});
