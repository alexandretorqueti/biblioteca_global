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
      simplesNacional INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)

  const columns = await all("PRAGMA table_info(clientes)")

  if (!columns.some((column) => column.name === "data")) {
    await run("ALTER TABLE clientes ADD COLUMN data TEXT")
  }

  if (!columns.some((column) => column.name === "simplesNacional")) {
    await run(
      "ALTER TABLE clientes ADD COLUMN simplesNacional INTEGER NOT NULL DEFAULT 0",
    )
  }

  await run(`
    CREATE TABLE IF NOT EXISTS vendas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      idCliente INTEGER NOT NULL,
      valor REAL NOT NULL,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (idCliente) REFERENCES clientes(id)
    )
  `)
}

const selectCliente = `
  SELECT
    id,
    razaoSocial,
    nomeFantasia,
    cnpj,
    data,
    simplesNacional,
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

app.get("/api/clientes", async (request, response) => {
  try {
    const filters = []
    const params = []

    for (const field of ["razaoSocial", "nomeFantasia", "cnpj"]) {
      const value = request.query[field]

      if (typeof value === "string" && value.trim()) {
        filters.push(`LOWER(${field}) LIKE LOWER(?)`)
        params.push(`%${value.trim()}%`)
      }
    }

    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : ""

    const clientes = await all(
      `
        ${selectCliente}
        ${where}
        ORDER BY id DESC
      `,
      params,
    )

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
  const { razaoSocial, nomeFantasia, cnpj, data, simplesNacional } = request.body

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
          data,
          simplesNacional
        )
        VALUES (?, ?, ?, ?, ?)
      `,
      [
        razaoSocial.trim(),
        nomeFantasia.trim(),
        cnpj.trim(),
        data || null,
        simplesNacional ? 1 : 0,
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
  const { razaoSocial, nomeFantasia, cnpj, data, simplesNacional } = request.body

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
          simplesNacional = ?,
          updatedAt = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
      [
        razaoSocial.trim(),
        nomeFantasia.trim(),
        cnpj.trim(),
        data || null,
        simplesNacional ? 1 : 0,
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


const selectVenda = `
  SELECT
    vendas.id,
    vendas.idCliente,
    clientes.razaoSocial AS clienteRazaoSocial,
    vendas.valor,
    vendas.createdAt,
    vendas.updatedAt
  FROM vendas
  INNER JOIN clientes ON clientes.id = vendas.idCliente
`

app.get("/api/vendas", async (_request, response) => {
  try {
    const vendas = await all(`
      ${selectVenda}
      ORDER BY vendas.id DESC
    `)

    response.json(vendas)
  } catch (error) {
    response.status(500).json({
      message: "Não foi possível listar as vendas.",
      detail: error.message,
    })
  }
})

app.get("/api/vendas/:id", async (request, response) => {
  try {
    const venda = await get(
      `
        ${selectVenda}
        WHERE vendas.id = ?
      `,
      [request.params.id],
    )

    if (!venda) {
      response.status(404).json({
        message: "Venda não encontrada.",
      })
      return
    }

    response.json(venda)
  } catch (error) {
    response.status(500).json({
      message: "Não foi possível consultar a venda.",
      detail: error.message,
    })
  }
})

app.post("/api/vendas", async (request, response) => {
  const { idCliente, valor } = request.body

  if (!idCliente || valor === undefined || Number(valor) < 0) {
    response.status(400).json({
      message: "Cliente e valor são obrigatórios.",
    })
    return
  }

  try {
    const cliente = await get(
      "SELECT id FROM clientes WHERE id = ?",
      [idCliente],
    )

    if (!cliente) {
      response.status(400).json({
        message: "Cliente inválido.",
      })
      return
    }

    const result = await run(
      `
        INSERT INTO vendas (idCliente, valor)
        VALUES (?, ?)
      `,
      [idCliente, Number(valor)],
    )

    const venda = await get(
      `
        ${selectVenda}
        WHERE vendas.id = ?
      `,
      [result.id],
    )

    response.status(201).json(venda)
  } catch (error) {
    response.status(500).json({
      message: "Não foi possível cadastrar a venda.",
      detail: error.message,
    })
  }
})

app.put("/api/vendas/:id", async (request, response) => {
  const { idCliente, valor } = request.body

  if (!idCliente || valor === undefined || Number(valor) < 0) {
    response.status(400).json({
      message: "Cliente e valor são obrigatórios.",
    })
    return
  }

  try {
    const cliente = await get(
      "SELECT id FROM clientes WHERE id = ?",
      [idCliente],
    )

    if (!cliente) {
      response.status(400).json({
        message: "Cliente inválido.",
      })
      return
    }

    const result = await run(
      `
        UPDATE vendas
        SET
          idCliente = ?,
          valor = ?,
          updatedAt = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
      [idCliente, Number(valor), request.params.id],
    )

    if (result.changes === 0) {
      response.status(404).json({
        message: "Venda não encontrada.",
      })
      return
    }

    const venda = await get(
      `
        ${selectVenda}
        WHERE vendas.id = ?
      `,
      [request.params.id],
    )

    response.json(venda)
  } catch (error) {
    response.status(500).json({
      message: "Não foi possível atualizar a venda.",
      detail: error.message,
    })
  }
})

app.delete("/api/vendas/:id", async (request, response) => {
  try {
    const result = await run(
      "DELETE FROM vendas WHERE id = ?",
      [request.params.id],
    )

    if (result.changes === 0) {
      response.status(404).json({
        message: "Venda não encontrada.",
      })
      return
    }

    response.status(204).send()
  } catch (error) {
    response.status(500).json({
      message: "Não foi possível excluir a venda.",
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
