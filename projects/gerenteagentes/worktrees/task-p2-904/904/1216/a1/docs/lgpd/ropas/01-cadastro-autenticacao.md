# ROPA 01 — Cadastro e autenticação

- **Dados:** nome, e-mail, telefone, identificadores, CPF quando necessário,
  senha protegida e IP do evento.
- **Finalidade:** criar conta, autenticar o titular e permitir o uso da
  plataforma e dos subprojetos.
- **Base:** execução de contrato (Art. 7º, V); CPF por consentimento (Art. 11,
  I) ou obrigação legal (Art. 11, III).
- **Destinatários:** módulos de autenticação e projeto autorizado.
- **Retenção:** enquanto a conta estiver ativa e pelos prazos legais; cinco anos
  de inatividade acionam o processo de anonimização/exclusão.
- **Controles:** senha em Argon2id, CPF criptografado e tokens de curta duração.
