/**
 * Script para rodar o seed dos agentes padrão no database do projeto gerenteagentes.
 * 
 * Uso:
 *   cd project/biblioteca-global
 *   npm run db:seed
 *   npx tsx projects/gerenteagentes/seed-agentes.ts
 */
import mysql from "mysql2/promise"
import { loadEnv } from "../../database/env.js"

interface Agente {
  nome: string
  modelo: string
  descricao?: string
  ativo?: boolean
}

const AGENTES_PADRAO: Agente[] = [
  {
    nome: "Claude (Anthropic)",
    modelo: "claude-3-5-sonnet-20241022",
    descricao: "Agente Claude 3.5 Sonnet para análise e codificação",
    ativo: true,
  },
  {
    nome: "Gemma (Google)",
    modelo: "gemma-2-27b-it",
    descricao: "Agente Gemma 27B para tarefas gerais",
    ativo: true,
  },
  {
    nome: "Llama (Meta)",
    modelo: "llama-3.3-70b",
    descricao: "Agente Llama 3.3 70B para codificação avançada",
    ativo: true,
  },
  {
    nome: "Qwen (Alibaba)",
    modelo: "qwen3-coder-next",
    descricao: "Agente Qwen Coder Next para desenvolvimento",
    ativo: true,
  },
]

export async function seedAgentes(): Promise<void> {
  const env = loadEnv()
  
  // Obter o ID do projeto gerenteagentes no database core (precisa de root)
  const coreConnection = await mysql.createConnection({
    host: env.MYSQL_HOST,
    port: Number(env.MYSQL_PORT),
    user: "root",
    password: env.MYSQL_ROOT_PASSWORD,
    database: env.MYSQL_DATABASE, // database core
  })

  try {
    const [projetoRows] = await coreConnection.query(
      "SELECT id FROM projetos WHERE slug = 'gerenteagentes'"
    )
    const projeto = (projetoRows as Array<{ id: number }>)[0]
    
    if (!projeto) {
      throw new Error("Projeto gerenteagentes não encontrado no database core")
    }

    const database = `projeto_${projeto.id}`
    console.log(`Usando database: ${database} (projeto id: ${projeto.id})`)

    const projectConnection = await mysql.createConnection({
      host: env.MYSQL_HOST,
      port: Number(env.MYSQL_PORT),
      user: env.MYSQL_USER,
      password: env.MYSQL_PASSWORD,
      database,
    })

    try {
      for (const agente of AGENTES_PADRAO) {
        await projectConnection.query(
          `
          INSERT INTO agentes (nome, modelo, descricao, ativo)
          VALUES (?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            modelo = VALUES(modelo),
            descricao = VALUES(descricao),
            ativo = VALUES(ativo)
        `,
          [agente.nome, agente.modelo, agente.descricao ?? null, agente.ativo ?? true],
        )
      }

      console.log(`✅ Seed concluído: ${AGENTES_PADRAO.length} agentes adicionados/atualizados`)
      
      // Listar os agentes criados
      const [agentesRows] = await projectConnection.query("SELECT id, nome, modelo FROM agentes")
      console.log("\nAgentes disponíveis:")
      for (const agente of agentesRows as Array<{ id: number; nome: string; modelo: string }>) {
        console.log(`  - ${agente.id}: ${agente.nome} (${agente.modelo})`)
      }
    } finally {
      await projectConnection.end()
    }
  } finally {
    await coreConnection.end()
  }
}

if (require.main === module) {
  seedAgentes().catch((erro) => {
    console.error("❌ Seed de agentes falhou:", erro)
    process.exitCode = 1
  })
}
