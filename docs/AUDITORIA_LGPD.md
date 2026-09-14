# Auditoria LGPD — Biblioteca Global

**Versão:** 1.0  
**Vigência:** 01/09/2026  
**Controladora:** Global Tecnologia  
**Encarregado (DPO):** privacidade@globaltecnologia.com.br

## 1. Escopo e governança

Este documento é o Registro de Operações de Tratamento (ROPA) da plataforma
Biblioteca Global e dos sistemas gerados por ela. Os subprojetos utilizam a
política e os controles da plataforma, sem afastar responsabilidades legais
específicas que possam surgir em cada operação.

## 2. ROPA — operações de tratamento

| Operação | Dados | Titulares | Finalidade | Base legal | Retenção |
| --- | --- | --- | --- | --- | --- |
| Cadastro e autenticação | nome, e-mail, telefone, identificador, senha protegida, CPF quando necessário | usuários | criar conta, autenticar e prestar o serviço | Art. 7º, V; CPF: Art. 11, I ou III | vigência da conta e prazos legais |
| Armazenamento no core | dados cadastrais, vínculos de projeto e consentimentos | usuários | manter a conta, permissões e histórico de aceites | Art. 7º, V; Art. 7º, I | vigência da conta e prazos legais |
| Operação dos subprojetos | dados inseridos nas telas e relações do projeto | usuários e pessoas registradas pelo projeto | executar funcionalidades solicitadas pelo controlador do subprojeto | Art. 7º, V, IX ou consentimento, conforme o caso | definido pelo projeto e obrigações legais |
| Segurança e auditoria | IP, identificador do usuário, tipo de dado, ação e data/hora | usuários | prevenir fraude, investigar incidentes e demonstrar conformidade | Art. 7º, IX e X | mínimo necessário, observados prazos legais |
| Atendimento aos direitos | dados de identificação e solicitação do titular | usuários | exportar, corrigir, anonimizar ou eliminar dados | Art. 18 e Art. 7º, VI | pelo prazo necessário à prestação de contas |
| Comunicações transacionais | e-mail e mensagens de autenticação | usuários | enviar códigos e avisos indispensáveis ao serviço | Art. 7º, V | pelo prazo técnico e legal aplicável |

Os detalhes operacionais de cada tratamento estão em `docs/lgpd/ropas/`.

## 3. Bases legais por finalidade

- **Nome, e-mail e telefone:** execução de contrato, Art. 7º, V, quando
  necessários para cadastro, autenticação, atendimento e prestação do serviço.
- **CPF:** consentimento específico e destacado, Art. 11, I, ou cumprimento de
  obrigação legal/regulatória, Art. 11, III. O CPF é protegido com criptografia
  forte e não deve ser solicitado além do necessário.
- **Senha:** execução de contrato, Art. 7º, V. A senha nunca é armazenada em
  claro; somente o hash Argon2id é persistido.
- **IP e logs:** exercício regular de direitos, Art. 7º, VI, e proteção do
  ambiente, Art. 7º, IX e X, limitados ao necessário.
- **Consentimento:** registrado com versão da política, data e IP para prova do
  aceite e pode ser revisto pelo titular.

## 4. Direitos do titular

O titular pode solicitar confirmação, acesso, correção, portabilidade,
anonimização, bloqueio, eliminação, informação sobre compartilhamentos e
revogação do consentimento, respeitadas as exceções legais. Os canais técnicos
da plataforma são exportação, retificação e exclusão; solicitações também podem
ser encaminhadas ao DPO.

## 5. Política de retenção

Contas sem atividade por **5 anos** serão identificadas por rotina automática e
submetidas à exclusão/anonimização, salvo obrigação legal, exercício regular de
direitos, investigação ou outra hipótese que justifique a conservação. Backups
seguem seu ciclo técnico de expiração e não são restaurados para reter dados
eliminados sem avaliação do DPO.

## 6. Medidas de segurança

- criptografia AES-256-GCM para CPF, com chave em `CPF_ENCRYPTION_KEY`;
- senhas protegidas com Argon2id;
- segregação física de banco por projeto;
- JWT de curta duração, refresh revogável e revalidação de vínculo;
- controle de acesso por perfil e escopo derivado do token;
- logs de acesso a dados sensíveis, sem registrar valores pessoais em claro;
- princípio do menor privilégio, revisão de acessos e gestão de segredos fora do
  código-fonte;
- validação de entrada e tratamento de erros sem exposição de dados.

## 7. Plano de resposta a incidentes

1. **Detectar e conter:** registrar o evento, preservar evidências, limitar
   acessos e revogar tokens/chaves comprometidos.
2. **Avaliar:** identificar dados, titulares, período, causa, extensão e risco;
   envolver o DPO e a direção responsável.
3. **Corrigir:** eliminar a vulnerabilidade, restaurar o serviço com segurança,
   revisar credenciais e documentar as ações.
4. **Notificar:** quando houver risco ou dano relevante, preparar comunicação à
   ANPD em até **72 horas** a partir da ciência do incidente, contendo natureza,
   titulares afetados, medidas adotadas e contato do DPO.
5. **Comunicar titulares:** informar de modo claro, direto e tempestivo os
   riscos, dados envolvidos, medidas de proteção e orientações práticas.
6. **Pós-incidente:** elaborar relatório, aplicar lições aprendidas, atualizar o
   ROPA e acompanhar as medidas preventivas.

## 8. Contato do DPO

Solicitações, dúvidas e incidentes relacionados a dados pessoais devem ser
encaminhados para **privacidade@globaltecnologia.com.br**.
