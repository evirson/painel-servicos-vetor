---
name: verify
description: Como subir e verificar o painel-servicos-vetor de ponta a ponta (Docker + Playwright)
---

# Verificação do painel-servicos-vetor

## Subir

```powershell
docker compose up --build -d        # postgres + worker (API :4400) + web (:3300)
# aguardar http://localhost:4400/health responder {"ok":true}
docker compose exec worker npm run db:seed   # banco sobe vazio; seed cria 3 alvos de exemplo
```

Rebuild de um serviço após mudar código: `docker compose up --build -d worker` (ou `web`).
O código vai por COPY no build — não há hot reload nos containers.

## Credenciais

Admin criado no boot do worker via env do docker-compose.yml:
`admin@vetor.com.br` / `troque-esta-senha`.
Login da API: `POST /api/auth/login` com corpo `{"email":..., "password":...}` (campo é
`password`, não `senha`) → `{token}`. Demais rotas `/api/*` exigem `Authorization: Bearer`.

## Fluxos que valem dirigir

- Público: `GET :3300/` (sem auth).
- Admin: login em `:3300/login` → `/admin` (token fica em localStorage) → botão "Histórico"
  abre `/admin/targets/[id]` (stats 24h/7d/30d, incidentes, checagens).
- API: `/api/targets/:id/{stats,checks,incidents}`; o alvo Firebird do seed fica `down`
  (ECONNREFUSED) e gera um incidente aberto — bom para testar a tela de incidentes.

## UI headless

Playwright funciona (instalar no scratchpad: `npm install playwright` +
`npx playwright install chromium`). Selectors: botão de login é `button:has-text("Entrar")`
(sem type=submit); linhas da lista do admin são `div.bg-white.rounded-lg`.

## Gotchas

- PS 5.1: `Invoke-WebRequest` sem `-UseBasicParsing` trava em NonInteractive; prefira
  `curl.exe` para sondar a API.
- `npm install` local (npm >= 11) remove campos `libc` do package-lock.json — reverter esse
  churn antes de commitar.
- Portas: web 3300, API 4400, Postgres host 55432.
