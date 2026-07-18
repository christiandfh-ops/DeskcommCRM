# Baseline Stabilization

Fase 0.5 iniciada na branch `chore/baseline-stabilization`, apos merge da auditoria documental no `main`.

Escopo desta fase: estabilizar o baseline tecnico em Linux, tornar o build reproduzivel, provar o estado de ARM64 cedo e remover falso verde conhecido em `db:migrate`. Nao houve alteracao de Auth, RLS, schema, Supabase, WAHA ou regra de negocio.

## Ambiente

- Host: Windows com Docker Desktop.
- Ambiente canonico executado em container Linux `node:20-slim`.
- Node: `v20.20.2`.
- pnpm: `9.15.9`.
- Docker no container: `29.6.1`.
- Actions no fork `christiandfh-ops/DeskcommCRM`: habilitado, `allowed_actions=all`.

O projeto agora declara `packageManager: pnpm@9.15.9`, alinhado ao Dockerfile. A branch preserva `.nvmrc` com Node 20.

## Arquivos Alterados

- `.gitattributes`: adiciona `*.sh text eol=lf`.
- `package.json`: adiciona `packageManager` e faz `db:migrate` falhar explicitamente enquanto nao houver runner real.
- `.github/workflows/ci.yml`: fixa pnpm `9.15.9` e adiciona jobs separados para invariantes SQL e build.
- `.github/workflows/perf.yml`: usa `packageManager` como fonte unica de pnpm e executa build com `SENTRY_DSN=off`.
- `.github/workflows/arm64-proof.yml`: adiciona prova nativa ARM64 sem QEMU, sem GHCR e sem push.
- `.github/workflows/publish-image.yml`: remove publicacao automatica em push para `main`.
- Shell scripts: renormalizados para LF no working tree. `git diff --ignore-space-at-eol -- '*.sh'` nao mostrou alteracao de conteudo.
- `docs/modernization/BASELINE_STABILIZATION.md`: este relatorio.

## Comandos Executados

### Setup Canonico

```bash
docker run --rm \
  -v "$PWD:/repo" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v crmwhatsapp-node-modules:/repo/node_modules \
  -v crmwhatsapp-pnpm-store:/pnpm-store \
  -w /repo node:20-slim bash -lc '<comando>'
```

### Gates Linux

```bash
corepack enable
corepack prepare pnpm@9.15.9 --activate
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test:unit
pnpm test:db
NEXT_TELEMETRY_DISABLED=1 SENTRY_DSN=off pnpm build
```

### Docker

```bash
docker buildx inspect --bootstrap
docker buildx build --platform linux/amd64 -t deskcommcrm:baseline-amd64 --load .
docker buildx build --platform linux/arm64 -t deskcommcrm:baseline-arm64 --load .
```

## Resultados

| Gate | Resultado | Evidencia |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | Verde | Concluiu em `3m 13.3s` com pnpm `9.15.9`. |
| `pnpm typecheck` | Verde | Exit code zero. |
| `pnpm lint` | Verde com avisos | Avisos existentes de hooks/deps e import nao usado; sem falha. |
| `pnpm test:unit` | Verde | 22 arquivos, 165 testes. |
| `pnpm test:db` | Verde no comportamento atual | 15 arquivos de invariantes, 96 testes. |
| Reaplicacao estrita de `baseline.sql` | Limitacao legado mapeada | Falha com `ERROR: multiple primary keys for table "ai_agent_runs" are not allowed`; nao sera corrigida nesta fase. |
| `pnpm build` | Verde | Gerou `.next/BUILD_ID=SDYQ4h95eO-X1IMOjW4sh`; `.next` com 236M; duracao 670s. |
| `db:migrate` | Verde como hardening | Retorna exit code 1 com mensagem explicita, removendo falso sucesso. |
| Docker `linux/amd64` | Verde | Imagem `deskcommcrm:baseline-amd64`, ID `sha256:99385c6c94419f16ac4cfc094be4874d5e63554d137f0409d3819754f6b59b5d`, tamanho local 378MB. |
| Smoke container `linux/amd64` | Parcial verde | Next iniciou e escutou em `3000`; `/api/v1/health` retornou `503` com placeholders, esperado sem infraestrutura real. |
| Docker `linux/arm64` | Verde em runner ARM64 nativo | `ubuntu-24.04-arm`, `uname -m=aarch64`, Docker server `arm64`; build nativo e smoke passaram. |

## Invariantes SQL

O script atual `pnpm test:db` passa. A instalacao inicial do `baseline.sql` passa com `ON_ERROR_STOP=1`, e os invariantes existentes tambem passam. O comportamento legado, porem, faz a segunda aplicacao do `baseline.sql` sem `ON_ERROR_STOP=1` e imprime `update ok` apesar de erros SQL tolerados.

Uma reaplicacao estrita foi executada fora do script, usando PostgreSQL em container e `ON_ERROR_STOP=1` nas duas aplicacoes. A primeira aplicacao passou. A segunda falhou no primeiro erro reproduzivel:

```text
psql:<stdin>:1910: ERROR: multiple primary keys for table "ai_agent_runs" are not allowed
```

Conclusao: a reaplicacao estrita de `baseline.sql` nao e idempotente. Essa e uma limitacao real do mecanismo legado e nao sera corrigida nesta fase, porque o baseline sera substituido por migrations versionadas na arquitetura nova.

O mecanismo atual nao deve ser usado como base de producao futura. A evolucao de schema exigira migrations incrementais, versionadas, transacionais, com registro de versao aplicado e falha explicita em qualquer erro SQL inesperado.

## Build

`pnpm build` concluiu com exit code zero e gerou `.next/BUILD_ID`.

Avisos observados:

- `next lint` depreciado.
- Avisos existentes de hooks/deps em componentes React.
- Turbopack reportou avisos sobre `import-in-the-middle` e versoes diferentes usadas por instrumentacao OpenTelemetry.
- Variaveis opcionais de IA/impersonation ausentes produziram avisos, sem falhar o build.

Nao houve evidencia de dependencia de segredo real durante o build. Foram usadas variaveis dummy ou `SENTRY_DSN=off`.

## ARM64

O builder local `buildx` reportou suporte a `linux/amd64` e `linux/arm64`, mas o build local `linux/arm64` falhou ao executar comandos simples em stages Alpine:

```text
exec /bin/sh: exec format error
```

A falha ocorreu em `RUN addgroup ...` e `RUN corepack enable ...`, antes de instalar dependencias do projeto. Portanto, neste ambiente, o bloqueio caracteriza falha de emulacao/binfmt/QEMU do builder local, nao incompatibilidade comprovada do codigo ou de dependencia nativa da aplicacao.

O lockfile contem variantes arm64/musl ou arm64/gnu para dependencias nativas relevantes como `sharp`, `@next/swc`, `esbuild`, `@sentry/cli`, `@rollup/rollup-*`, `@unrs/resolver-binding-*` e `@napi-rs/canvas`.

Proxima verificacao recomendada: repetir a prova em GitHub Actions com QEMU/Buildx ou em host ARM64 nativo antes de concluir compatibilidade com Oracle ARM64.

A prova foi repetida no GitHub Actions em runner nativo `ubuntu-24.04-arm`, sem QEMU e sem publicacao de imagem:

- `uname -m=aarch64`.
- Docker server `arm64`.
- `docker build -t deskcommcrm:ci-arm64 .` passou.
- O container iniciou e aceitou conexoes na porta `3000`.
- `/api/v1/health` retornou HTTP `503` somente porque Supabase, Redis e WAHA foram placeholders no smoke.

Conclusao: a imagem do app foi construida e iniciou em ARM64 nativo. O erro local anterior fica classificado como falha de binfmt/QEMU do builder local, nao como incompatibilidade do codigo.

## CI

O workflow de CI foi ajustado por leitura e diff para:

- Node 20.
- pnpm via `packageManager: pnpm@9.15.9` como fonte unica.
- install frozen.
- `typecheck`, `lint`, `test:unit`.
- invariantes SQL em job separado.
- build em job separado.
- `SENTRY_DSN=off` nos builds de CI/performance.

Actions esta habilitado no fork. Nenhuma configuracao do GitHub foi alterada automaticamente.

Checks executados no Draft PR:

- `verify`: pass, `1m10s`.
- `db-invariants`: pass, `48s`.
- `build`: pass, `2m27s`.
- `build-and-size`: pass, `2m18s`.
- `build-and-smoke`: pass, `3m49s`.

## Publicacao

`publish-image.yml` nao foi acionado nesta fase. Nao houve `workflow_dispatch`, tag, release ou push para `main`.

Push para `main` deixou de publicar imagem. A publicacao agora exige tag `v*`, release `published` ou acionamento manual por `workflow_dispatch`.

O release workflow continua `linux/amd64` apenas. Antes da primeira publicacao para producao, ele devera virar multiarch com `linux/amd64` e `linux/arm64`.

## Recomendacao

Fase 0.5 aprovada apos merge deste PR.

Gates verdes: typecheck, lint, unit, build, performance build, invariantes no comportamento atual, Docker amd64, smoke parcial amd64, build ARM64 nativo e smoke ARM64.

Limitacao legada aceita:

- O baseline SQL legado fica documentado como nao idempotente e nao deve ser promovido como mecanismo futuro de migration.
- Essa limitacao nao bloqueia a modernizacao porque `baseline.sql` nao sera o migration runner da arquitetura nova.

Proxima fatia recomendada antes da Fase 1:

1. Fazer merge deste PR apos revisao final.
2. Abrir a Fase 1 com ADR da arquitetura, contexto transacional, RLS preservado e testes de isolamento.
3. Substituir o baseline legado por migrations incrementais, versionadas e transacionais.
