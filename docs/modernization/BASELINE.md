# Baseline de Modernizacao - Fase 0

Data da auditoria: 2026-07-18  
Repositorio original: `melgarafael/DeskcommCRM`  
Fork: `christiandfh-ops/DeskcommCRM`  
Branch: `chore/baseline-audit`  
HEAD auditado: `59b0d337a2bd8fe2d2589295d7eab96942c0046f`

## Escopo

Esta fase registrou o estado real do projeto antes de qualquer retirada de Supabase ou mudanca funcional. Nenhum codigo de producao, schema, dependencia ou arquivo de ambiente foi alterado.

## Preparacao Git

- `gh auth status`: autenticado em `github.com` como `christiandfh-ops`.
- `gh repo fork melgarafael/DeskcommCRM --default-branch-only`: fork criado/reutilizado em `https://github.com/christiandfh-ops/DeskcommCRM`.
- `git clone https://github.com/christiandfh-ops/DeskcommCRM.git .`: clone do fork no workspace.
- `git remote add upstream https://github.com/melgarafael/DeskcommCRM.git`: original configurado como `upstream`.
- `git checkout -b chore/baseline-audit`: branch exclusiva criada.

Remotes verificados:

- `origin`: `https://github.com/christiandfh-ops/DeskcommCRM.git`
- `upstream`: `https://github.com/melgarafael/DeskcommCRM.git`

Licenca: `LICENSE` contem MIT. O README tambem declara MIT. A documentacao desta fase nao remove nem substitui creditos.

## Arquivos lidos primeiro

- `README.md`
- `CLAUDE.md` (nao havia `AGENTS.md` na raiz)
- `package.json`
- `Dockerfile`
- `docker-compose.yml`
- `docker-compose.prod.yml`
- `docker-compose.build.yml`
- `.github/workflows/ci.yml`
- `.github/workflows/perf.yml`
- `.github/workflows/publish-image.yml`
- `scripts/README.md`
- `hostgator-setup-kit/README.md`
- `hostgator-setup-kit/install.sh`
- `hostgator-setup-kit/backup.sh`
- `hostgator-setup-kit/update.sh`
- `supabase/migrations/MANIFEST.md`
- `supabase/baseline.sql`
- migrations em `supabase/migrations/`

## Ambiente local

- OS/shell: Windows + PowerShell.
- Node: `v26.4.0`.
- pnpm global: `11.9.0`.
- npm: `11.17.0`.
- Docker daemon: `29.6.1`.
- Docker Buildx: `v0.35.0-desktop.2`.
- Buildx builder `desktop-linux`: suporta `linux/amd64` e `linux/arm64`, entre outras plataformas.

Observacao: workflows e Dockerfile usam pnpm 9, mas o ambiente local resolveu `pnpm` para v11. Isso afetou os comandos `pnpm <script>`.

## Instalacao de dependencias

Comando:

```bash
pnpm install --frozen-lockfile
```

Resultado real:

- As duas primeiras tentativas travaram sem saida ate o timeout.
- A tentativa com `--reporter=append-only` materializou `node_modules`, mas saiu com erro de supply-chain/build approval do pnpm v11:
  - `@sentry/cli`
  - `esbuild`
  - `sharp`
  - `unrs-resolver`
- Nao rodei `pnpm approve-builds`, porque isso alteraria a politica local do workspace nesta fase.

Impacto: `pnpm typecheck` tentou reexecutar/validar install e falhou antes de chamar `tsc`. Para capturar o estado do codigo, os binarios locais foram chamados diretamente.

## Comandos executados

| Comando | Resultado |
| --- | --- |
| `pnpm typecheck` | Falhou antes do TypeScript por `ERR_PNPM_IGNORED_BUILDS`. |
| `.\node_modules\.bin\tsc.cmd --noEmit` | Passou. |
| `.\node_modules\.bin\next.cmd lint` | Passou com warnings. |
| `.\node_modules\.bin\vitest.cmd run` | Passou: 22 arquivos, 165 testes. |
| `bash scripts/test-db.sh` | Falhou antes dos invariantes por ambiente/line endings: `set: pipefail\r: invalid option name`. |
| `.\node_modules\.bin\next.cmd build --turbopack` | Nao completou dentro do timeout; processo filho terminou depois sem `.next/BUILD_ID`. |
| `docker buildx inspect --bootstrap` | Passou; builder local suporta amd64 e arm64. |
| `docker manifest inspect ghcr.io/melgarafael/deskcommcrm:latest` | Passou; manifest publicado tem `linux/amd64` e um entry `unknown/unknown`, sem `linux/arm64`. |

## Lint warnings

- `app/admin/(protected)/lgpd/_client.tsx`: `Button` importado e nao usado.
- `app/app/ai/agents/_components/AgentsList.tsx`: dependencia de `useMemo` pode mudar a cada render.
- `components/kanban/KanbanBoard.tsx`: dependencia de `useMemo`/`useCallback` pode mudar a cada render.
- `next lint` esta depreciado e sera removido no Next 16.

## Testes existentes

Passaram 165 testes unitarios cobrindo, entre outros:

- RBAC matrix.
- bulk assign de leads.
- assignment/claim/release de conversas.
- team role change e guarda de ultimo admin.
- MFA/recovery/auth helpers.
- schemas de contacts/leads/messaging/settings.
- filtros de inbox.
- bot veto/handoff.
- cliente API e retry em 429.

## Testes/invariantes ausentes ou nao executados

- Invariantes SQL/RLS existem em `tests/invariants/`, mas nao foram executados no Windows atual por falha de `scripts/test-db.sh` com CRLF/bash.
- E2E Playwright nao foi executado porque exige dev server, credenciais/fixtures e baseline de banco funcional.
- Nao ha teste de caracterizacao da migracao para PostgreSQL sem Supabase.
- Nao ha teste de contrato para uma interface `WhatsAppProvider`; o envio atual esta acoplado a WAHA.
- Nao ha teste automatizado de build Docker multiarch arm64; workflow publica apenas amd64.

## Estado reproduzivel minimo

Para reproduzir o estado auditado:

```bash
git clone https://github.com/christiandfh-ops/DeskcommCRM.git DeskcommCRM
cd DeskcommCRM
git remote add upstream https://github.com/melgarafael/DeskcommCRM.git
git checkout -b chore/baseline-audit 59b0d337a2bd8fe2d2589295d7eab96942c0046f
pnpm install --frozen-lockfile
.\node_modules\.bin\tsc.cmd --noEmit
.\node_modules\.bin\next.cmd lint
.\node_modules\.bin\vitest.cmd run
```

Em Linux/CI, usar pnpm 9 como nos workflows deve ser testado antes de tratar os problemas de pnpm v11 como falha do projeto.

