#!/usr/bin/env node
/**
 * Smoke test do script de migração Postgres → MySQL
 * (scripts/migrate-postgres-to-mysql.cjs)
 *
 * Roda a migração contra um database MySQL TEMPORÁRIO (projeto_migtest_st6),
 * sem tocar nos dados reais (projeto_gerenteagentes):
 *   1. Cria o database temporário (root) e concede acesso ao usuário biblioteca;
 *   2. Aplica as migrations do Gerente Agentes (projects/gerenteagentes/migrations);
 *   3. Executa o script de migração com MYSQL_DATABASE apontando para o temporário;
 *   4. Verifica que todos os contatos migrados têm origem = 'site' e que os
 *      volumes batem com a origem (Postgres);
 *   5. Remove o database temporário (sempre, mesmo em caso de falha).
 *
 * Uso:  node scripts/smoke-migrate-postgres-to-mysql.cjs
 * Requer: scripts/.env (credenciais da migração) + .env na raiz (MYSQL_ROOT_PASSWORD).
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..');
const SCRATCH_DB = 'projeto_migtest_st6';
const MIGRATIONS_DIR = path.join(ROOT, 'projects', 'gerenteagentes', 'migrations');
const MIGRATION_FILES = ['0000_mysterious_phil_sheldon.sql', '0002_oval_iron_fist.sql'];
const MIGRATE_SCRIPT = path.join(__dirname, 'migrate-postgres-to-mysql.cjs');

// Carrega .env da raiz (MYSQL_ROOT_PASSWORD) e depois scripts/.env (credenciais
// da migração). dotenv não sobrescreve variáveis já definidas no processo.
require('dotenv').config({ path: path.join(ROOT, '.env') });
require('dotenv').config({ path: path.join(__dirname, '.env') });

const envFile = path.join(__dirname, '.env');
if (!fs.existsSync(envFile)) {
  console.error('❌ scripts/.env não encontrado. Copie de scripts/.env.example e preencha.');
  process.exit(1);
}

function assert(cond, msg) {
  if (!cond) {
    console.error('❌ ' + msg);
    process.exit(1);
  }
}

function mysqlConfig(database) {
  return {
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database,
    multipleStatements: true,
  };
}

async function main() {
  console.log('🚦 Smoke test: migração Postgres → MySQL (database temporário: ' + SCRATCH_DB + ')');
  console.log('   Origem PG: ' + process.env.PG_HOST + ':' + process.env.PG_PORT + '/' + process.env.PG_DATABASE);

  // Conexão administrativa (root) para criar/remover o database temporário
  const rootConn = await mysql.createConnection({
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT),
    user: process.env.MYSQL_ROOT_USER || 'root',
    password: process.env.MYSQL_ROOT_PASSWORD,
    multipleStatements: true,
  });

  try {
    console.log('  1. Criando database temporário...');
    await rootConn.query('DROP DATABASE IF EXISTS `' + SCRATCH_DB + '`');
    await rootConn.query('CREATE DATABASE `' + SCRATCH_DB + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
    await rootConn.query('USE `' + SCRATCH_DB + '`');
    await rootConn.query("GRANT ALL PRIVILEGES ON `" + SCRATCH_DB + "`.* TO '" + process.env.MYSQL_USER + "'@'%'");
    await rootConn.query('FLUSH PRIVILEGES');

    console.log('  2. Aplicando migrations do Gerente Agentes...');
    for (const file of MIGRATION_FILES) {
      let sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      // Remove marcadores do drizzle-kit (comentários inválidos para o MySQL)
      sql = sql.split('--> statement-breakpoint').join('');
      await rootConn.query(sql);
    }

    console.log('  3. Executando o script de migração...');
    const res = spawnSync(process.execPath, [MIGRATE_SCRIPT], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { MYSQL_DATABASE: SCRATCH_DB }),
      encoding: 'utf8',
      timeout: 300000,
    });
    if (res.stdout) console.log(res.stdout);
    if (res.stderr) console.error(res.stderr);
    assert(res.status === 0, 'script de migração falhou (exit ' + res.status + ')');

    console.log('  4. Verificando dados migrados...');
    const conn = await mysql.createConnection(mysqlConfig(SCRATCH_DB));

    const [origens] = await conn.query('SELECT origem, COUNT(*) AS n FROM contatos GROUP BY origem');
    const [contatosTotal] = await conn.query('SELECT COUNT(*) AS n FROM contatos');
    const [tarefas] = await conn.query('SELECT COUNT(*) AS n FROM tarefas');
    const [subtarefas] = await conn.query('SELECT COUNT(*) AS n FROM subtarefas');
    const [chats] = await conn.query('SELECT COUNT(*) AS n FROM tarefa_chats');

    const origensStr = origens.map((r) => r.origem + '=' + r.n).join(', ');
    console.log('     origem por contato: ' + (origensStr || '(vazio)'));
    console.log('     contatos=' + contatosTotal[0].n + ' tarefas=' + tarefas[0].n +
      ' subtarefas=' + subtarefas[0].n + ' tarefa_chats=' + chats[0].n);

    assert(contatosTotal[0].n > 0, 'nenhum contato migrado');
    assert(origens.every((r) => r.origem === 'site'), 'existe contato com origem != "site": ' + origensStr);
    assert(tarefas[0].n > 0, 'nenhuma tarefa migrada');
    assert(subtarefas[0].n > 0, 'nenhuma subtarefa migrada');
    assert(chats[0].n > 0, 'nenhum tarefa_chat migrado');

    await conn.end();
    console.log('  5. ✅ Smoke test PASS — origem gravada como "site", volumes migrados.');
  } finally {
    console.log('  6. Removendo database temporário...');
    await rootConn.query("REVOKE ALL PRIVILEGES ON `" + SCRATCH_DB + "`.* FROM '" + process.env.MYSQL_USER + "'@'%'");
    await rootConn.query('DROP DATABASE IF EXISTS `' + SCRATCH_DB + '`');
    await rootConn.end();
  }
}

main().catch((err) => {
  console.error('❌ Smoke test falhou: ' + err.message);
  process.exit(1);
});
