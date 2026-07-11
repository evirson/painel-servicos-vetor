# Painel de Serviços Vetor

Painel de monitoramento (status page) para acompanhar a saúde de APIs, bancos de dados,
integrações de e-commerce/marketplace, o middleware **Asta/Firebird** (legado Delphi 2007) e o
status dos web services fiscais da **SEFAZ**. Tem duas faces:

- **Página pública** (`/`) — para o cliente ver a disponibilidade dos serviços.
- **Painel admin** (`/admin`) — para a equipe cadastrar serviços, checar na hora e ver estatísticas.

Veja o desenho completo em [`PLANO.md`](./PLANO.md).

## Arquitetura

```
apps/
  web/        Next.js — página pública + painel admin
  worker/     Fastify (API REST) + agendador de checagens em processo
packages/
  db/         Prisma + PostgreSQL (config dos alvos + histórico)
  probes/     sondas: tcp (db/firebird/asta), http, sefaz
```

## Rodar com Docker (recomendado)

```bash
docker compose up --build
```

- Página pública: http://localhost:3300
- Admin: http://localhost:3300/admin
- API: http://localhost:4400

> O worker precisa alcançar seus bancos/Firebird/Asta na rede interna. Se esses recursos estiverem
> no **host** da máquina, descomente `extra_hosts` no `docker-compose.yml` e use
> `host.docker.internal` como endereço nos cadastros.

## Rodar local (sem Docker)

Requisitos: Node 20+ e um PostgreSQL acessível.

```bash
cp .env.example .env          # ajuste DATABASE_URL
npm install
npm run db:push               # cria as tabelas
npm run db:seed               # (opcional) dados de exemplo
npm run dev:worker            # API + agendador em :4400
npm run dev:web               # front em :3300  (outro terminal)
```

## Tipos de serviço monitorável

| Tipo       | Sonda | O que valida |
|------------|-------|--------------|
| `http_api` | HTTP  | status/latência/conteúdo de uma API |
| `db_port`  | TCP   | porta de banco aberta (SQL Server, MySQL, Postgres…) |
| `firebird` | TCP   | Firebird de pé (porta 3050) |
| `asta`     | TCP   | middleware Asta/Delphi de pé |
| `sefaz`    | HTTP  | acessibilidade do web service da SEFAZ (status serviço) |

### Como adicionar um novo tipo de serviço
1. Adicione o valor no enum `ProbeType` em `packages/db/prisma/schema.prisma`.
2. Crie a sonda em `packages/probes/src/<tipo>.ts`.
3. Mapeie o tipo em `packages/probes/src/index.ts` (`runProbe`).
4. `npm run db:push` e (se necessário) inclua o tipo no formulário do admin.

## Notas de implementação

- **Agendamento:** feito em processo (um timer por alvo, ressincronizado a cada 30s). Para múltiplos
  workers/filas distribuídas no futuro, troque `apps/worker/src/scheduler.ts` por BullMQ + Redis.
- **Estatísticas:** `GET /api/targets/:id/stats?hours=24` retorna uptime % e latência média.
- **SEFAZ:** monta o envelope SOAP do `NfeStatusServico4`, envia e lê o `cStat` (107 = em operação
  → `up`; 108/109 → `down`; demais → `degraded`). Config do alvo: `uf`, `ambiente`
  (`producao`/`homologacao`) e a `url` do web service da UF. Se a UF exigir certificado A1 (mTLS),
  informe `certPath`/`certPassphrase` no `config` do alvo ou as envs `NFE_CERT_PFX_PATH` /
  `NFE_CERT_PASS`. Para autorizadores que usam SOAP 1.1, defina `config.soapVersion = "1.1"`.
- **Autenticação do admin:** login por e-mail/senha (bcrypt) com JWT. Todas as rotas `/api` exigem
  token, exceto `/api/public/*`, `/api/auth/login` e `/health`. Defina `AUTH_SECRET` em produção.
  O front guarda o token no `localStorage` e envia via `Authorization: Bearer`.

## Autenticação / primeiro acesso

Defina `ADMIN_EMAIL` e `ADMIN_PASSWORD` (no `.env` ou no `docker-compose.yml`) — no boot o worker
cria/atualiza esse admin. Para criar/alterar outro admin manualmente:

```bash
npm --workspace @vetor/worker run create-admin admin@vetor.com.br minhaSenha
```

Acesse `http://localhost:3300/login`, entre e você será levado ao `/admin`.
