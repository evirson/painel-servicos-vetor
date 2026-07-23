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
- **Agente no VPS (Fase B) ✅ feito.** `apps/agent/` — script Node sem dependências npm que roda
  no servidor monitorado e empurra métricas por HTTPS (`POST /api/ingest/agent`, autenticado por
  token do `Host` com hash bcrypt). Reporta disco, CPU, memória, containers (Engine API pelo
  socket, sem CLI) e portas locais. Cada item vira um `Target` auto-provisionado com
  `publico: false`. Inclui **watchdog**: alvo push sem relato há mais de 3× o intervalo vira
  `down`, senão um agente morto deixaria tudo verde para sempre.
- **Pendente:** Fase D (alertas) e a implantação real no VPS — ver a seção 9.

**Segurança — Autenticação** ✅ feito
- Login e-mail/senha (bcrypt) + JWT; rotas `/api` protegidas exceto `/api/public/*`,
  `/api/auth/login`, `/api/ingest/*` (token próprio do agente) e `/health`.
- **Rate limiting** (`apps/worker/src/rate-limit.ts`): 5 falhas em 15 min bloqueiam por 15 min,
  contando por IP **e** por e-mail (só por IP, ataque distribuído passa; só por e-mail, qualquer
  um tranca a conta do admin de fora). Usa `X-Forwarded-For` para funcionar atrás do nginx.
  Contadores em memória — reiniciar o worker os zera.

---

## 8. Estado atual (2026-07-23)

- Tudo na **`main`**. Rodando local via `docker compose up --build`:
  público em `:3300`, admin em `:3300/admin`, API em `:4400`, Postgres host `55432`.
- O `.dockerignore` é **essencial** (sem ele, o `node_modules` arm64 do macOS quebra o build Linux).
- Banco vem vazio numa subida limpa; `docker compose exec worker npm run db:seed` cria o grupo
  Infraestrutura (ping + TCP 22/80/443 no VPS) e o alvo da SEFAZ.
- `SECRETS_KEY` é obrigatória para o cofre de credenciais funcionar (senão as rotas dão 503).
  Está no `.env` local, que é gitignored. **Se ela se perder, os segredos gravados são perdidos.**

## 9. Próximo passo: implantar no VPS (retomar aqui)

**Decisão de 2026-07-23:** hospedar o painel **no próprio 77.37.41.177**, atrás do nginx que já
existe, num subdomínio — como solução **temporária** para validar tudo funcionando, migrando para
fora depois.

> ⚠️ Enquanto morar nesse VPS, o painel **não detecta a queda do próprio VPS**: cai junto e a
> página pública fica muda justamente quando o cliente vai consultá-la. É um débito aceito
> conscientemente, não um esquecimento.

**Bloqueado aguardando (perguntado em 2026-07-23, sem resposta ainda):**
1. Qual subdomínio (ex.: `status.vetor.com.br`) e se o DNS já aponta para 77.37.41.177.
2. Como o nginx roda no VPS (container ou host) e como os certificados são emitidos (certbot?).
3. Usuário SSH (precisa estar no grupo `docker`).
4. Instalar a chave pública: `ssh-copy-id -i ~/.ssh/painel_vetor_vps.pub <user>@77.37.41.177`
   (par gerado em 2026-07-23; a privada fica em `~/.ssh/painel_vetor_vps`).

**Plano do deploy** — mexer só no que for novo, sem tocar nos projetos existentes:
- `git clone` numa pasta nova + `docker compose up` com portas altas ligadas só em `127.0.0.1`.
- **Novo** server block no nginx para o subdomínio, com certificado.
- Agente como mais um container (ver `apps/agent/README.md`), com `PORTAS` apontando para os
  bancos internos e `MOUNTS=/hostfs`.
- Gerar **no servidor** segredos novos: `SECRETS_KEY`, `AUTH_SECRET` e uma senha de admin real —
  `troque-esta-senha` não pode ir para a internet.
- O cofre local **não se transfere** (a `SECRETS_KEY` de lá é outra): recadastrar as credenciais
  pelo admin depois de subir.

**Depois disso:** Fase D — alertas (e-mail/Telegram) com flap damping, mais um
dead-man's-switch externo para avisar se o próprio painel morrer.

> ⚠️ **`ping` não funciona sob Docker Desktop (macOS/Windows)**: a pilha de rede em espaço de
> usuário responde ao ICMP em vez de encaminhá-lo, e qualquer IP "responde". A sonda detecta
> isso pingando 192.0.2.1 (TEST-NET, RFC 5737) e reporta `degraded` com o motivo, em vez de um
> falso `up`. Em host Linux (produção) funciona normalmente.

## 10. Pendências que não são de código

- **Certificado A1 da SEFAZ (PR).** O arquivo em `~/Documents/projetos/CERTIFICADO EC 15.04.205 -
  SENHA Shaft212536.pfx` **não abre com a senha que está no próprio nome** — testado com OpenSSL 3
  e com o Node (`mac verify failure`), em ~12 variações. O PKCS#12 é íntegro; a senha é que está
  errada. A data no nome sugere validade vencida (2025/2026). Precisa do arquivo/senha corretos.
- **Arquivo com os dados do VPS** (mencionado em 2026-07-23) não foi localizado: só existe
  `~/Documents/projetos/message.txt`, que é a documentação da API de bloqueio de grupo do
  `ws_vetor-gestor` (porta 9096) — não tem nada do VPS. Busca por `77.37.41.177` na pasta
  `projetos` inteira não retornou nada.
- **Marca da Vetor** na página pública (único item que falta da Fase 4).

## 11. Pontos em aberto para confirmar depois
- Portas reais do Asta e do Firebird no ambiente da Vetor.
- ~~Quais UFs entram no monitoramento SEFAZ~~ → **PR** (2026-07-13); outras UFs conforme a base
  de clientes crescer.
- ~~Se a consulta de status da SEFAZ exigirá certificado~~ → **PR exige A1/mTLS** (confirmado
  2026-07-13); falta obter o .pfx da Vetor e a senha para montar no worker.
- Onde exatamente será implantado (on-premise vs cloud) — define a estratégia de rede/VPN.
- Autenticação: hoje sem rate-limiting nem refresh token; avaliar antes de expor fora da rede.
