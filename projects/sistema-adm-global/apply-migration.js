#!/usr/bin/env node
/**
 * Script para aplicar a migration 0004_legado_mirror.sql no banco projeto_6241.
 * 
 * Uso:
 *   node apply-migration.js
 * 
 * Requer variáveis de ambiente:
 *   MYSQL_HOST, MYSQL_PORT, MYSQL_ROOT_PASSWORD
 * 
 * Ou execute no contexto da API onde essas variáveis já estão disponíveis.
 */

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

async function applyMigration() {
  const host = process.env.MYSQL_HOST || 'host.docker.internal';
  const port = parseInt(process.env.MYSQL_PORT || '3308');
  const password = process.env.MYSQL_ROOT_PASSWORD;
  const database = 'projeto_6241';

  if (!password) {
    console.error('ERRO: MYSQL_ROOT_PASSWORD não definida');
    console.error('Defina a variável de ambiente ou execute no contexto da API');
    process.exit(1);
  }

  console.log(`Conectando ao banco ${database} em ${host}:${port}...`);
  
  const connection = await mysql.createConnection({
    host,
    port,
    user: 'root',
    password,
    database,
    multipleStatements: true
  });

  try {
    // Verifica se a migration já foi aplicada
    const [rows] = await connection.query(
      'SELECT * FROM __drizzle_migrations WHERE name LIKE ?',
      ['0004%']
    );

    if (rows.length > 0) {
      console.log('Migration 0004 já foi aplicada. Pulando.');
      return;
    }

    // Lê o arquivo SQL
    const migrationPath = path.join(__dirname, 'migrations', '0004_legado_mirror.sql');
    const sql = fs.readFileSync(migrationPath, 'utf8');

    console.log('Aplicando migration 0004_legado_mirror.sql...');
    
    // Divide por statement-breakpoint e executa cada statement
    const statements = sql.split('--> statement-breakpoint').map(s => s.trim()).filter(s => s && !s.startsWith('--'));
    
    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i];
      try {
        await connection.query(stmt);
        console.log(`  Statement ${i + 1}/${statements.length} executado com sucesso`);
      } catch (err) {
        console.error(`  ERRO no statement ${i + 1}:`, err.message);
        console.error(`  SQL: ${stmt.substring(0, 100)}...`);
        throw err;
      }
    }

    // Registra a migration em __drizzle_migrations
    const now = Date.now();
    await connection.query(
      'INSERT INTO __drizzle_migrations (hash, created_at, name) VALUES (?, ?, ?)',
      [`manual_apply_${now}`, now, '0004_legado_mirror.sql']
    );

    console.log('✓ Migration 0004 aplicada com sucesso!');
    console.log('✓ Registrada em __drizzle_migrations');

  } finally {
    await connection.end();
  }
}

applyMigration().catch(err => {
  console.error('ERRO:', err.message);
  process.exit(1);
});
