import cors from "cors"
import express from "express"
import sqlite3 from "sqlite3"
import { mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const dataDir = resolve(__dirname, "../data")
const databasePath = resolve(dataDir, "backend_exemplo.sqlite")
const port = Number(process.env.PORT ?? 3001)

mkdirSync(dataDir, { recursive: true })

const db = new sqlite3.Database(databasePath)
const app = express()

app.use(cors())
app.use(express.json())

const run = (sql, params = []) =>
  new Promise((resolvePromise, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) {
        reject(error)
        return
      }

      resolvePromise({
        id: this.lastID,
        changes: this.changes,
      })
    })
  })

const all = (sql, params = []) =>
  new Promise((resolvePromise, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) {
        reject(error)
        return
      }

      resolvePromise(rows)
    })
  })

const get = (sql, params = []) =>
  new Promise((resolvePromise, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) {
        reject(error)
        return
      }

      resolvePromise(row)
    })
  })

const initializeDatabase = async () => {
  await run(`
    CREATE TABLE IF NOT EXISTS clientes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      razaoSocial TEXT NOT NULL,
      nomeFantasia TEXT NOT NULL,
      cnpj TEXT NOT NULL UNIQUE,
      data TEXT,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)

  const columns = await all("PRAGMA table_info(clientes)")

  if (!columns.some((column) => column.name === "data")) {
    await run("ALTER TABLE clientes ADD COLUMN data TEXT")
  }
}

const selectCliente = `
  SELECT
    id,
    razaoSocial,
    nomeFantasia,
    cnpj,
    data,
    createdAt,
    updatedAt
  FROM clientes
`

app.get("/health", (_request, response) => {
  response.json({
    status: "ok",
    service: "backend_exemplo",
  })
})

app.get("/api/clientes", async (_request, response) => {
  try {
    const clientes = await all(`
      ${selectCliente}
      ORDER BY id DESC
    `)

    response.json(clientes)
  } catch (error) {
    response.status(500).json({
      message: "Não foi possível listar os clientes.",
      detail: error.message,
    })
  }
})

app.get("/api/clientes/:id", async (request, response) => {
  try {
    const cliente = await get(
      `
        ${selectCliente}
        WHERE id = ?
      `,
      [request.params.id],
    )

    if (!cliente) {
      response.status(404).json({
        message: "Cliente não encontrado.",
      })
      return
    }

    response.json(cliente)
  } catch (error) {
    response.status(500).json({
      message: "Não foi possível consultar o cliente.",
      detail: error.message,
    })
  }
})

app.post("/api/clientes", async (request, response) => {
  const { razaoSocial, nomeFantasia, cnpj, data } = request.body

  if (!razaoSocial || !nomeFantasia || !cnpj) {
    response.status(400).json({
      message: "Razão Social, Nome Fantasia e CNPJ são obrigatórios.",
    })
    return
  }

  try {
    const result = await run(
      `
        INSERT INTO clientes (
          razaoSocial,
          nomeFantasia,
          cnpj,
          data
        )
        VALUES (?, ?, ?, ?)
      `,
      [
        razaoSocial.trim(),
        nomeFantasia.trim(),
        cnpj.trim(),
        data || null,
      ],
    )

    const cliente = await get(
      `
        ${selectCliente}
        WHERE id = ?
      `,
      [result.id],
    )

    response.status(201).json(cliente)
  } catch (error) {
    const status = error.message.includes("UNIQUE") ? 409 : 500

    response.status(status).json({
      message:
        status === 409
          ? "Já existe um cliente cadastrado com este CNPJ."
          : "Não foi possível cadastrar o cliente.",
      detail: error.message,
    })
  }
})

app.put("/api/clientes/:id", async (request, response) => {
  const { razaoSocial, nomeFantasia, cnpj, data } = request.body

  if (!razaoSocial || !nomeFantasia || !cnpj) {
    response.status(400).json({
      message: "Razão Social, Nome Fantasia e CNPJ são obrigatórios.",
    })
    return
  }

  try {
    const result = await run(
      `
        UPDATE clientes
        SET
          razaoSocial = ?,
          nomeFantasia = ?,
          cnpj = ?,
          data = ?,
          updatedAt = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
      [
        razaoSocial.trim(),
        nomeFantasia.trim(),
        cnpj.trim(),
        data || null,
        request.params.id,
      ],
    )

    if (result.changes === 0) {
      response.status(404).json({
        message: "Cliente não encontrado.",
      })
      return
    }

    const cliente = await get(
      `
        ${selectCliente}
        WHERE id = ?
      `,
      [request.params.id],
    )

    response.json(cliente)
  } catch (error) {
    const status = error.message.includes("UNIQUE") ? 409 : 500

    response.status(status).json({
      message:
        status === 409
          ? "Já existe outro cliente cadastrado com este CNPJ."
          : "Não foi possível atualizar o cliente.",
      detail: error.message,
    })
  }
})

app.delete("/api/clientes/:id", async (request, response) => {
  try {
    const result = await run(
      "DELETE FROM clientes WHERE id = ?",
      [request.params.id],
    )

    if (result.changes === 0) {
      response.status(404).json({
        message: "Cliente não encontrado.",
      })
      return
    }

    response.status(204).send()
  } catch (error) {
    response.status(500).json({
      message: "Não foi possível excluir o cliente.",
      detail: error.message,
    })
  }
})

initializeDatabase()
  .then(() => {
    app.listen(port, "0.0.0.0", () => {
      console.log(`backend_exemplo disponível em http://localhost:${port}`)
    })
  })
  .catch((error) => {
    console.error("Erro ao inicializar o banco de dados:", error)
    process.exit(1)
  })
