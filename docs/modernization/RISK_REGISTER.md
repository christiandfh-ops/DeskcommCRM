# Registro de Riscos - Fase 0

## Criticos

| Risco | Evidencia | Impacto | Mitigacao |
| --- | --- | --- | --- |
| Supabase e plataforma, nao biblioteca | Auth, RLS, Realtime, Storage, RPCs, service role e baseline SQL estao acoplados ao runtime. | Remover imports quebra login, MFA, tenancy, webhooks, IA, LGPD e realtime. | Migrar por contratos: auth, tenancy, SQL functions, repositorios, realtime e storage separadamente. |
| Service role bypassa RLS | `createAdminClient()` e usado em muitas rotas/workers/scripts. | Vazamento cross-tenant se qualquer query perder filtro manual. | Testes de caracterizacao para todo handler service-role; repositorios exigindo `organization_id` por tipo. |
| Invariantes SQL nao executaram localmente | `bash scripts/test-db.sh` falhou com `pipefail\r`. | Sem prova local de RLS/SQL antes da migracao. | Rodar em Linux/WSL limpo com line endings corretos; incluir no baseline CI antes de mexer no schema. |
| RPCs SQL sao parte da regra de negocio | WAHA, LGPD, IA, budget e assignment chamam funcoes SQL. | Portar apenas tabelas perde comportamento atomico e idempotente. | Inventariar assinatura/semantica de cada RPC e criar testes antes de reimplementar. |
| Realtime depende de RLS Supabase | Hooks usam `postgres_changes`; comentarios dizem que RLS filtra eventos. | Novo realtime pode vazar eventos entre orgs. | WebSocket/realtime proprio deve autenticar conexao e filtrar por org no servidor. |
| Reaplicacao do `baseline.sql` nao prova idempotencia estrita | `scripts/test-db.sh` reexecuta `baseline.sql` sem `ON_ERROR_STOP` e imprime `update ok`; `hostgator-setup-kit/update.sh` filtra erros considerados benignos. | Falhas SQL reais podem ser toleradas, mascarando schema drift ou migrations nao idempotentes. | Criar reexecucao estrita do baseline sem falhas SQL toleradas ou classificar explicitamente cada erro esperado com asserts; update so pode imprimir sucesso se nao houver falha inesperada comprovada. |

## Altos

| Risco | Evidencia | Impacto | Mitigacao |
| --- | --- | --- | --- |
| Tooling baseline instavel no Windows com pnpm 11 | `pnpm <script>` falhou por `ERR_PNPM_IGNORED_BUILDS`; comandos diretos passaram parcialmente. | Falsos negativos e builds nao reproduziveis. | Reproduzir em ambiente CI/Linux com Node 20 + pnpm 9.15.9, igual Dockerfile/workflows. |
| Build nao completou | `next build --turbopack` nao gerou `.next/BUILD_ID`. | Sem prova de imagem/app produtivo nessa maquina. | Rodar build em Linux/CI com Node 20 + pnpm 9.15.9 e vars de build documentadas. |
| Docker publicado nao e multiarch | Manifest `ghcr.io/melgarafael/deskcommcrm:latest` tem `linux/amd64`, sem `linux/arm64`. | ARM64 nao esta validado para self-host. | Adicionar buildx multiarch ou documentar amd64-only; testar dependencias nativas. |
| HMAC WAHA pode ser pulado | Handlers pulam quando decrypt falha/placeholder. | Webhook sem assinatura efetiva se configuracao falhar silenciosamente. | Fail-closed em producao; teste de assinatura invalida/ausente. |
| `organization_id` nullable em logs/admin | `api_audit_log`, `incidents`, `webhook_events_log`. | Queries podem misturar plataforma e tenant. | Policies e repositorios separados para escopo platform vs tenant. |
| Telemetria Sentry comunitaria ativa por padrao | `lib/sentry/dsn.ts` usa `DEFAULT_SENTRY_DSN` quando `SENTRY_DSN` esta vazio; configs Sentry usam `tracesSampleRate: 1`, `enableLogs: true`, `sendDefaultPii: false`; o README documenta opt-out com `SENTRY_DSN=off`. O risco a revisar inclui tambem replay quando habilitado: `replaysSessionSampleRate 0.1` e `replaysOnErrorSampleRate 1.0`. | Em self-host open source, telemetria padrao para DSN externo pode conflitar com expectativa operacional/LGPD, mesmo com scrubbing. | Telemetria off por padrao ou DSN proprio obrigatorio; revisao LGPD; testes comprovando que nada e enviado quando desligada; documentar claramente traces, logs e replay. |
| `db:migrate` retorna sucesso sem migrar | `package.json` define `db:migrate` como `echo 'TODO: wire supabase db push or pg-migrate' && exit 0`. | CI ou operadores podem receber falso verde de migracao. | Implementar runner real ou fazer o comando falhar explicitamente ate existir implementacao. |
| CI atual nao cobre build nem invariantes SQL no gate principal | `.github/workflows/ci.yml` roda typecheck, lint e unit; build esta em `perf.yml`; invariantes SQL nao aparecem nos workflows. Nao foram observados runs no fork para a branch do PR. | PR pode parecer verde sem build, sem RLS/invariantes e possivelmente sem Actions habilitado no fork. | Incluir build e `test:invariants` no gate antes da Fase 1; verificar se GitHub Actions esta habilitado no fork. |

## Medios

| Risco | Evidencia | Impacto | Mitigacao |
| --- | --- | --- | --- |
| `next lint` depreciado | Output informa remocao no Next 16. | CI futuro quebra ao atualizar Next. | Migrar para ESLint CLI em fase propria. |
| Warnings de hooks/render | Lint warnings em LGPD, AgentsList e KanbanBoard. | Possivel re-render desnecessario; baixo risco funcional imediato. | Corrigir depois de baseline, com testes de UI se tocar comportamento. |
| Onboarding WhatsApp duplicado/legado | Rotas onboarding usam `org_<8chars>`; channel-sessions usa multi-numero. | Migração Meta pode acoplar no fluxo errado. | Definir `channel_sessions` como contrato canonico e tratar onboarding legacy. |
| Storage de midia incompleto | README fala `whatsapp-media`; codigo mistura `media_url` e `media_storage_path`. | Migracao de storage pode perder midia/retencao LGPD. | Desenhar contrato de MediaStorage antes de migrar mensagens. |

## Ordem de migracao sugerida

1. Reproduzir baseline em Linux/CI com Node 20 + pnpm 9.15.9: typecheck, lint, unit, invariantes SQL e build.
2. Criar testes de caracterizacao para Auth/MFA/RBAC, tenancy, service-role filters, WAHA inbound/outbound e RPCs criticas.
3. Introduzir contexto transacional + RLS em PostgreSQL proprio, usando `SET LOCAL` e policies baseadas em `current_setting(..., true)`.
4. Validar Meta API em laboratorio isolado.
5. Definir interfaces comuns (`MessagingProvider` e `ChannelProvisioner`) depois do laboratorio Meta.
6. Portar schema/funcoes para Postgres proprio mantendo contratos.
7. Substituir Auth Supabase por camada propria/adaptador.
8. Substituir Realtime.
9. Substituir Storage.
10. Remover Supabase packages/imports somente quando os contratos acima estiverem cobertos.

## Complexidade relativa

| Fase | Complexidade | Motivo |
| --- | --- | --- |
| Baseline CI/Linux e invariantes | Media | Tooling e banco local precisam estabilizar. |
| Testes de caracterizacao | Alta | Cobrem comportamento distribuido em SQL, API, workers e realtime. |
| Fundacao multiempresa em Postgres | Alta | Auth, roles, contexto transacional e RLS propria precisam preservar o isolamento existente. |
| Portar RPCs SQL | Alta | Ha regras atomicas de WAHA, LGPD, IA e assignment. |
| Substituir Auth/MFA | Alta | MFA, recovery, cookies, admin API e scripts dependem de Supabase Auth. |
| Substituir Realtime | Media-alta | Precisa preservar isolamento de eventos. |
| Substituir Storage | Media | Menos espalhado, mas LGPD/midia exigem cuidado. |
| Interfaces WhatsApp (`MessagingProvider`/`ChannelProvisioner`) | Media | O fluxo WAHA e claro, mas os contratos de idempotencia, status, midia e provisionamento ainda precisam considerar Meta. |
| Laboratorio Meta | Media-alta | Deve acontecer antes de congelar interfaces e antes de adicionar provider alternativo. |
