# Painel de Serviços Vetor — Plano do Projeto

Painel de monitoramento (status page) para acompanhar a saúde de APIs, bancos de dados,
integrações de e-commerce/marketplace, o middleware Asta/Firebird (legado Delphi 2007) e o
status dos web services fiscais da SEFAZ. Objetivo duplo: **painel interno** para configurar e
diagnosticar, e **página pública** para mostrar aos clientes que os sistemas da Vetor operam
normalmente.

---

## 1. Decisões já tomadas

| Tema | Decisão |
|------|---------|
| Backend | **Node.js + TypeScript** (Fastify) com worker agendado |
| Frontend | **Next.js + TypeScript + Tailwind + shadcn/ui** |
| Banco de dados (do painel) | **PostgreSQL** (via Prisma) |
| Fila/agendamento | **Redis + BullMQ** |
| Empacotamento | **Docker** (docker-compose) |
| Legado Delphi | Acesso a **Firebird via Asta** → monitorado como 2 alvos TCP (Asta + Firebird 3050) |
| Fiscal | Monitorar **status dos web services SEFAZ** (por UF) |

---

## 2. Arquitetura

```
monorepo/
├─ apps/
│  ├─ web/        Next.js — página pública de status + painel admin
│  └─ worker/     Fastify (API REST) + scheduler (BullMQ) que executa as checagens
├─ packages/
│  ├─ db/         Prisma schema + client (PostgreSQL)
│  └─ probes/     sondas reutilizáveis: http, tcp, firebird, asta, sefaz
└─ docker-compose.yml   web + worker + postgres + redis
```

**Fluxo de uma checagem:**
1. Scheduler (BullMQ repeatable jobs) enfileira uma checagem por alvo, no intervalo configurado.
2. Worker pega o job, executa a sonda correspondente ao `tipo` do alvo.
3. Grava um registro em `Check` (status, latência, mensagem de erro).
4. Se o estado mudou (ex.: UP→DOWN), abre/fecha um `Incident`.
5. A página pública lê o estado atual + histórico agregado.

---

## 3. Tipos de alvo e sondas

| Tipo | Sonda | Como funciona | O que valida |
|------|-------|---------------|--------------|
| `http_api` | HTTP | GET/POST no endpoint | status code esperado, latência, (opcional) trecho no corpo |
| `db_port` | TCP | abre socket no host:porta | porta aceitando conexão (SQL Server 1433, MySQL 3306, Postgres 5432) |
| `firebird` | TCP | socket na porta 3050 (`gds_db`) | Firebird de pé; **opção futura**: `SELECT 1` real |
| `asta` | TCP | socket na porta do Asta | middleware Delphi de pé |
| `sefaz` | HTTP/SOAP | consulta "status serviço" da SEFAZ por UF | autorizadora no ar (NFe/NFC-e) |

> **Nota sobre o Delphi 2007:** o componente Asta é um servidor de aplicação socket-based; não
> precisa de sonda especial. Ele entra como um alvo `asta` (a porta do middleware) e o Firebird
> por trás entra como alvo `firebird`. Um heartbeat ponta-a-ponta (Asta→Firebird→volta) fica como
> evolução futura.

### Sonda SEFAZ (detalhe)
- Cada UF tem uma URL de web service próprio; o serviço de interesse é o **NfeStatusServico**
  (ambiente de produção).
- A sonda faz a consulta de status e interpreta o `cStat` de retorno (ex.: `107` = serviço em
  operação). Guardamos a UF, o ambiente e o `cStat`/`xMotivo`.
- Cadastro por UF onde a Vetor tem clientes emitindo. NFS-e (por prefeitura) fica **fora do
  escopo inicial** — pode virar tipo `nfse` depois.

---

## 4. Modelo de dados (Prisma — essência)

```
Target
  id, nome, tipo (http_api|db_port|firebird|asta|sefaz),
  host, porta, url, config (JSON: métodos, headers, UF, cStat esperado…),
  intervaloSegundos, ativo, statusGroupId

StatusGroup            // agrupa alvos na página pública
  id, nome (ex.: "Fiscal", "E-commerce", "Interno"), ordem

Check                  // histórico de execuções
  id, targetId, timestamp, status (up|down|degraded), latenciaMs, mensagem

Incident               // janelas de indisponibilidade
  id, targetId, inicio, fim (null = em aberto), resumo

User                   // acesso ao painel admin
  id, email, senhaHash, papel (admin|viewer)
```

Retenção: `Check` cresce rápido — plano é agregar em resumos diários (uptime %, latência média)
e manter o detalhado por ~90 dias.

---

## 5. Superfícies (telas)

### Página pública (`/`)
- Banner geral: "Todos os sistemas operacionais" / "Incidente em andamento".
- Grupos (Fiscal, E-commerce, Interno) com semáforo verde/amarelo/vermelho por serviço.
- Uptime % e barra de histórico de 90 dias por serviço (estilo Statuspage).
- Marca da Vetor. Sem dados sensíveis (host/porta ficam ocultos ao público).

### Painel admin (`/admin`, autenticado)
- CRUD de alvos e grupos.
- Teste manual ("checar agora") de um alvo.
- Linha do tempo de checagens e incidentes por alvo.
- Configuração de intervalos e limiares de latência.

---

## 6. Segurança e operação
- Admin protegido por autenticação (email+senha, sessão). Segredos (senhas de banco, tokens de
  API) fora do código, em variáveis de ambiente / secret store.
- Certificado digital A1 da SEFAZ, **se** for necessário para a consulta de status: guardado como
  segredo montado no worker (a consulta de *status serviço* às vezes não exige certificado —
  confirmar por UF).
- Página pública read-only, cacheável, sem expor topologia interna.
- Rede: como parte dos alvos é interna (Firebird/Asta/bancos), o worker precisa de rota até a rede
  do legado — em Docker, via rede host/VPN conforme onde for implantado.

---

## 7. Roadmap e progresso

> Decisão de implementação: o agendamento ficou **em processo** (um timer por alvo no worker),
> não com Redis/BullMQ — menos um container. Trocar por BullMQ é isolado em `scheduler.ts`.

**Fase 1 — Esqueleto** ✅ feito
- Monorepo (npm workspaces), docker-compose (postgres + worker + web), Prisma schema, Fastify +
  Next.js subindo.

**Fase 2 — Sondas base** ✅ feito
- `tcp` (cobre db_port, firebird, asta) e `http_api`. Agendador rodando e gravando `Check`,
  abrindo/fechando `Incident` na transição de/para `down`.

**Fase 3 — Admin** ✅ feito
- CRUD de alvos/grupos, "checar agora" e tela de histórico/estatísticas por serviço
  (`/admin/targets/[id]`: uptime/latência por período 24h/7d/30d, incidentes e checagens;
  API `/incidents` adicionada ao lado de `/stats` e `/checks`).

**Fase 4 — Página pública** ✅ feito
- Grupos, semáforos, uptime % e histórico de 90 dias. **Falta:** aplicar a marca da Vetor.

**Fase 5 — Fiscal** ✅ parcial
- Sonda `sefaz` real: envelope SOAP `NfeStatusServico4`, envio via `node:https` (suporta A1/mTLS),
  leitura do `cStat` (107=up, 108/109=down).
- **UF definida: PR** (principal base de clientes). Endpoint validado até o handshake TLS:
  `https://nfe.sefa.pr.gov.br/nfe/NFeStatusServico4` — a SEFA-PR **exige certificado A1 (mTLS)**
  até para o status serviço (alerta TLS 42 sem cert; alerta 46 com cert fora da ICP-Brasil).
  Erro de certificado vira `degraded` com mensagem explicativa (não `down`), para não abrir
  incidente falso na página pública. **Falta:** montar o A1 real da Vetor no worker
  (`NFE_CERT_PFX_PATH`/`NFE_CERT_PASS` ou volume `./certs` — ver docker-compose.yml) e
  confirmar o `cStat 107` de ponta a ponta.

**Fase 6 — Refino** ⬜ pendente
- Alertas (e-mail/Telegram/webhook), retenção/agregação de métricas, heartbeat Asta→Firebird.

**Fase 7 — Monitoramento do VPS** ✅ parcial (A feita; C, B e D pendentes)
- Sondas novas: `ping` (host vivo) e `tls_cert` (validade do certificado do nginx).
  `ping` separado do TCP de propósito: ping up + 443 down = nginx quebrado; ambos down = host caiu.
- **Cadastro de Projetos** (`/admin/projetos`): nome + endereço do front/API; o botão
  "Gerar alvos" deriva automaticamente o `http_api` (público) e o `tls_cert` (interno).
  Idempotente.
- **Cofre de credenciais** (`/admin/credenciais`): AES-256-GCM com chave em `SECRETS_KEY`.
  Falha fechado sem a chave; listagem sempre mascarada; texto puro só em
  `POST /api/credenciais/:id/revelar`, que registra quem revelou no log.
- Página pública: grupos sem serviço público são omitidos, e o banner ganhou o estado
  âmbar "instabilidade" (antes, um alvo degradado deixava tudo vermelho para sempre).
- **Escala (Fase C) ✅ feita.** Medido com 30 alvos × 90 dias (3,9M linhas em `Check`): o
  `/api/public/status` levava **46s e derrubava o worker por OOM** (exit 137) — e como o
  agendador roda no mesmo processo, o monitoramento inteiro parava. Um cliente abrindo a página
  de status era suficiente. Agora: tabela `CheckDaily` (resumo por alvo/dia, 3,9M → 2.735
  linhas), job horário em `apps/worker/src/rollup.ts` (agrega via `groupBy` no banco, nunca
  carrega linhas no Node) e poda de `Check` além de `RETENCAO_DIAS` (90). Resultado: **31ms**,
  103MB de memória. O dia corrente é lido do bruto para não ficar defasado, e o resumo do dia é
  descartado antes de somar para não contar duas vezes.
- **Pendente:** Fase B (agente no VPS) e D (alertas) — ver a seção 9.

**Segurança — Autenticação** ✅ feito
- Login e-mail/senha (bcrypt) + JWT; rotas `/api` protegidas exceto `/api/public/*`,
  `/api/auth/login` e `/health`. Admin inicial via `ADMIN_EMAIL`/`ADMIN_PASSWORD`.

---

## 8. Estado atual (2026-07-13)

- Tudo mergeado na **`main`**; branch `feat/esqueleto-painel-auth` apagada. Trabalho segue direto na main.
- Portas (mudadas para evitar conflito com outro projeto local): **web 3300**, **API 4400**,
  **Postgres host 55432** (interno do container permanece 5432).
- Rodar: `docker compose up --build` → público em `:3300`, admin em `:3300/admin`, API em `:4400`.
  O `.dockerignore` é **essencial** (sem ele, o `node_modules` arm64 do macOS quebra o build Linux).
- Banco vem vazio numa subida limpa (compose roda só `db push`); popular exemplos com
  `docker compose exec worker npm run db:seed`.

## 9. Próximos passos do monitoramento do VPS (77.37.41.177)

Ordem acordada: **A → C → B → D**. A Fase A está feita.

- ~~**C — Escala**~~ ✅ feita (ver Fase 7 acima).
- **B — Agente no VPS.** Container que lê `docker ps` pela Engine API no socket, disco/CPU/RAM,
  e envia via `POST /api/ingest/agent` com token. Inclui watchdog de agente mudo (sem ele, um
  agente morto deixa tudo verde para sempre). Necessário porque 5432/3306/6379 estão fechados
  para a internet — de fora, banco e container são invisíveis.
- **D — Alertas** com flap damping + dead-man's-switch externo para o próprio painel.

> ⚠️ **Rate limiting no login virou obrigatório**, não opcional: com o cofre de credenciais, o
> painel passa a guardar senha de produção. Fazer antes de expor o admin fora da rede.

> ⚠️ **`ping` não funciona sob Docker Desktop (macOS/Windows)**: a pilha de rede em espaço de
> usuário responde ao ICMP em vez de encaminhá-lo, e qualquer IP "responde". A sonda detecta
> isso pingando 192.0.2.1 (TEST-NET, RFC 5737) e reporta `degraded` com o motivo, em vez de um
> falso `up`. Em host Linux (produção) funciona normalmente.

## 10. Pontos em aberto para confirmar depois
- Portas reais do Asta e do Firebird no ambiente da Vetor.
- ~~Quais UFs entram no monitoramento SEFAZ~~ → **PR** (2026-07-13); outras UFs conforme a base
  de clientes crescer.
- ~~Se a consulta de status da SEFAZ exigirá certificado~~ → **PR exige A1/mTLS** (confirmado
  2026-07-13); falta obter o .pfx da Vetor e a senha para montar no worker.
- Onde exatamente será implantado (on-premise vs cloud) — define a estratégia de rede/VPN.
- Autenticação: hoje sem rate-limiting nem refresh token; avaliar antes de expor fora da rede.
