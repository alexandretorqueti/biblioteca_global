#!/usr/bin/env node
/**
 * Script de migração Postgres (globalia) → MySQL (projeto_gerenteagentes)
 * 
 * Migra:
 * - contato_site → contatos
 * - projetos → projetos_captados
 * - project_definition → definicoes
 * - task → tarefas
 * - sub_task → subtarefas
 * - task_chat → tarefa_chats
 * - project_chat → projeto_chats
 * - agents (do projetos) → agentes
 */

const { Client: PgClient } = require('/data/workspace/projects/agentes/gerenteagentes/project/GerenteAgentes/node_modules/pg');
const mysql = require('mysql2/promise');

// Credenciais lidas EXCLUSIVAMENTE de scripts/.env (nada hardcoded — segurança).
// Modelo em scripts/.env.example; o .env é ignorado pelo git (scripts/.gitignore).
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const REQUIRED_ENV = [
  'PG_HOST', 'PG_PORT', 'PG_USER', 'PG_PASSWORD', 'PG_DATABASE',
  'MYSQL_HOST', 'MYSQL_PORT', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_DATABASE',
];
const missingEnv = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missingEnv.length > 0) {
  console.error('❌ Variáveis de ambiente ausentes: ' + missingEnv.join(', '));
  console.error('   Copie scripts/.env.example para scripts/.env, preencha as credenciais e rode de novo.');
  process.exit(1);
}

const PG_CONFIG = {
  host: process.env.PG_HOST,
  port: Number(process.env.PG_PORT),
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  database: process.env.PG_DATABASE,
};

const MYSQL_CONFIG = {
  host: process.env.MYSQL_HOST,
  port: Number(process.env.MYSQL_PORT),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
};

async function migrate() {
  console.log('🚀 Iniciando migração Postgres → MySQL\n');

  const pg = new PgClient(PG_CONFIG);
  await pg.connect();
  console.log('✓ Conectado ao Postgres');

  const mysqlConn = await mysql.createConnection(MYSQL_CONFIG);
  console.log('✓ Conectado ao MySQL\n');

  // Desabilitar FK checks durante migração
  await mysqlConn.query('SET FOREIGN_KEY_CHECKS = 0');

  // 1. Migrar agentes (extraídos de projetos.agent_id)
  console.log('📋 Migrando agentes...');
  const agentes = await pg.query('SELECT DISTINCT agent_id FROM globalia.projetos WHERE agent_id IS NOT NULL');
  let agentesCount = 0;
  for (const row of agentes.rows) {
    await mysqlConn.query(
      'INSERT INTO agentes (nome, modelo, descricao, ativo) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE nome = nome',
      [row.agent_id, 'ollama/qwen3.6', `Agente migrado do motor`, true]
    );
    agentesCount++;
  }
  console.log(`  ✓ ${agentesCount} agentes migrados\n`);

  // 2. Migrar contatos
  console.log('📋 Migrando contatos...');
  const contatos = await pg.query('SELECT * FROM globalia.contato_site ORDER BY created_at');
  const contatoMap = new Map();
  for (const row of contatos.rows) {
    // contato_site NÃO tem coluna origem no Postgres — origem é sempre 'site'
    const origem = 'site';
    const [result] = await mysqlConn.query(
      'INSERT INTO contatos (nome, email, telefone, origem, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [row.nome, row.email, row.telefone || null, origem, row.created_at, row.updated_at || row.created_at]
    );
    contatoMap.set(row.id, result.insertId);
  }
  console.log(`  ✓ ${contatos.rows.length} contatos migrados\n`);

  // 3. Migrar projetos
  console.log('📋 Migrando projetos...');
  const projetos = await pg.query('SELECT * FROM globalia.projetos ORDER BY created_at');
  const projetoMap = new Map();
  const agenteIdMap = new Map();
  
  // Mapear agent_id para o novo ID
  const agentesMysql = await mysqlConn.query('SELECT id, nome FROM agentes');
  for (const row of agentesMysql[0]) {
    agenteIdMap.set(row.nome, row.id);
  }
  
  for (const row of projetos.rows) {
    const contatoId = row.contato_id ? contatoMap.get(row.contato_id) : null;
    const agenteId = row.agent_id ? agenteIdMap.get(row.agent_id) : null;
    
    const [result] = await mysqlConn.query(
      `INSERT INTO projetos_captados (nome, slug, descricao, regras, contato_id, agente_id, ativo, created_at, updated_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.slug, row.slug, row.description || null, null, contatoId, agenteId, row.ativo, row.created_at, row.updated_at]
    );
    projetoMap.set(row.slug, result.insertId);
  }
  console.log(`  ✓ ${projetos.rows.length} projetos migrados\n`);

  // 4. Migrar definições
  console.log('📋 Migrando definições...');
  const definicoes = await pg.query('SELECT * FROM globalia.project_definition ORDER BY created_at');
  let definicoesCount = 0;
  for (const row of definicoes.rows) {
    // project_definition tem chat_id, não projeto_id diretamente
    // Precisamos encontrar o projeto pelo chat
    const chat = await pg.query('SELECT project_name FROM globalia.chat WHERE id = $1', [row.chat_id]);
    if (chat.rows.length > 0 && chat.rows[0].project_name) {
      const projetoId = projetoMap.get(chat.rows[0].project_name);
      if (projetoId) {
        await mysqlConn.query(
          'INSERT INTO definicoes (projeto_id, texto, seq, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
          [projetoId, row.definition, row.seq || 0, row.created_at, row.updated_at || row.created_at]
        );
        definicoesCount++;
      }
    }
  }
  console.log(`  ✓ ${definicoesCount} definições migradas\n`);

  // 5. Migrar tarefas
  console.log('📋 Migrando tarefas...');
  const tarefas = await pg.query('SELECT * FROM globalia.task ORDER BY created_at');
  const tarefaMap = new Map();
  for (const row of tarefas.rows) {
    const projetoId = row.project_slug ? projetoMap.get(row.project_slug) : null;
    const agenteId = row.agent_id ? agenteIdMap.get(row.agent_id) : null;
    
    // Se não tem projeto ou agente, usar o primeiro disponível
    const projetoIdFinal = projetoId || (projetoMap.size > 0 ? Array.from(projetoMap.values())[0] : null);
    const agenteIdFinal = agenteId || (agenteIdMap.size > 0 ? Array.from(agenteIdMap.values())[0] : null);
    
    if (!projetoIdFinal || !agenteIdFinal) {
      console.log(`  ⚠ Tarefa ${row.id} ignorada (sem projeto ou agente)`);
      continue;
    }
    
    const [result] = await mysqlConn.query(
      `INSERT INTO tarefas (projeto_id, agente_id, titulo, descricao, repo_path, build_command, unit_test_command, 
       status, max_rework, hard_timeout_ms, depends_on_task_id, auto_start, boot_retry_count, created_at, updated_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        projetoIdFinal,
        agenteIdFinal,
        row.title,
        row.description || null,
        row.repo_path || null,
        row.build_command || null,
        row.unit_test_command || null,
        row.status === 'aborted' ? 'failed' : row.status, // aborted → failed
        row.max_rework || 3,
        row.hard_timeout_ms || null,
        null, // depends_on_task_id será migrado depois
        row.auto_start || false,
        row.boot_retry_count || 0,
        row.created_at,
        row.updated_at || row.created_at
      ]
    );
    tarefaMap.set(row.id, result.insertId);
  }
  console.log(`  ✓ ${tarefas.rows.length} tarefas migradas\n`);

  // 6. Migrar subtarefas
  console.log('📋 Migrando subtarefas...');
  const subtarefas = await pg.query('SELECT * FROM globalia.sub_task ORDER BY created_at');
  let subtarefasCount = 0;
  for (const row of subtarefas.rows) {
    const tarefaId = tarefaMap.get(row.task_id);
    if (!tarefaId) {
      console.log(`  ⚠ Subtarefa ${row.id} ignorada (tarefa pai não encontrada)`);
      continue;
    }
    
    await mysqlConn.query(
      `INSERT INTO subtarefas (tarefa_id, seq, titulo, descricao, status, resultado, duracao_segundos, 
       iniciada_em, finalizada_em, created_at, updated_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tarefaId,
        row.seq || 0,
        row.title || `Subtarefa ${row.seq}`,
        row.description || null,
        row.status,
        row.result || null,
        row.duration_seconds || null,
        row.started_at || null,
        row.completed_at || null,
        row.created_at,
        row.updated_at || row.created_at
      ]
    );
    subtarefasCount++;
  }
  console.log(`  ✓ ${subtarefasCount} subtarefas migradas\n`);

  // 7. Migrar chats de tarefa
  console.log('📋 Migrando chats de tarefa...');
  const taskChats = await pg.query('SELECT * FROM globalia.task_chat ORDER BY created_at');
  let taskChatsCount = 0;
  for (const row of taskChats.rows) {
    const tarefaId = tarefaMap.get(row.task_id);
    if (!tarefaId) {
      console.log(`  ⚠ Chat ${row.id} ignorado (tarefa não encontrada)`);
      continue;
    }
    
    await mysqlConn.query(
      'INSERT INTO tarefa_chats (tarefa_id, role, texto, created_at) VALUES (?, ?, ?, ?)',
      [tarefaId, row.role, row.text, row.created_at]
    );
    taskChatsCount++;
  }
  console.log(`  ✓ ${taskChatsCount} chats de tarefa migrados\n`);

  // 8. Migrar chats de projeto
  console.log('📋 Migrando chats de projeto...');
  const projetoChats = await pg.query('SELECT * FROM globalia.project_chat ORDER BY created_at');
  let projetoChatsCount = 0;
  for (const row of projetoChats.rows) {
    const projetoId = projetoMap.get(row.project_slug);
    if (!projetoId) {
      console.log(`  ⚠ Chat ${row.id} ignorado (projeto não encontrado)`);
      continue;
    }
    
    await mysqlConn.query(
      'INSERT INTO projeto_chats (projeto_id, role, texto, created_at) VALUES (?, ?, ?, ?)',
      [projetoId, row.role, row.text, row.created_at]
    );
    projetoChatsCount++;
  }
  console.log(`  ✓ ${projetoChatsCount} chats de projeto migrados\n`);

  // Reabilitar FK checks
  await mysqlConn.query('SET FOREIGN_KEY_CHECKS = 1');

  console.log('✅ Migração concluída com sucesso!\n');
  console.log('Resumo:');
  console.log(`  - Agentes: ${agentesCount}`);
  console.log(`  - Contatos: ${contatos.rows.length}`);
  console.log(`  - Projetos: ${projetos.rows.length}`);
  console.log(`  - Definições: ${definicoesCount}`);
  console.log(`  - Tarefas: ${tarefas.rows.length}`);
  console.log(`  - Subtarefas: ${subtarefasCount}`);
  console.log(`  - Chats de tarefa: ${taskChatsCount}`);
  console.log(`  - Chats de projeto: ${projetoChatsCount}`);

  await pg.end();
  await mysqlConn.end();
}

migrate().catch(err => {
  console.error('❌ Erro na migração:', err.message);
  process.exit(1);
});
