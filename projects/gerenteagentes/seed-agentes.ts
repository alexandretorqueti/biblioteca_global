/**
 * Os agentes são mantidos pelo OpenClaw e não possuem seed local.
 * 
 * Uso:
 *   cd project/biblioteca-global
 *   npm run db:seed
 *   npx tsx projects/gerenteagentes/seed-agentes.ts
 */
export async function seedAgentes(): Promise<void> {
  console.log("✅ Seed de agentes ignorado: fonte de verdade é o OpenClaw")
}

if (require.main === module) {
  seedAgentes().catch((erro) => {
    console.error("❌ Seed de agentes falhou:", erro)
    process.exitCode = 1
  })
}
