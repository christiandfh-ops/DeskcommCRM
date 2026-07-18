# Inventario Supabase - Fase 0

## Resumo

O Supabase nao e apenas uma biblioteca de acesso a dados neste projeto. Ele fornece:

- Postgres e schema versionado.
- Auth, MFA e admin API.
- RLS baseada em `auth.uid()`.
- Realtime via `postgres_changes`.
- Storage para politicas IA/LGPD e caminho previsto para midia.
- RPCs SQL chamadas por app, workers, WAHA e IA.
- Service role para webhooks, crons, workers, administracao e scripts.

A retirada deve ser tratada como substituicao de plataforma, nao como remocao de imports.

## Pacotes

Dependencias diretas em `package.json`:

- `@supabase/ssr`
- `@supabase/supabase-js`

Arquivos canonicos:

- `lib/supabase/browser.ts`: browser client com `@supabase/ssr`, cookies e runtime public env.
- `lib/supabase/server.ts`: server client com cookies HttpOnly/SameSite strict.
- `lib/supabase/admin.ts`: admin client com service role; comentario explicito diz que bypassa RLS.
- `lib/database.types.ts`: tipos gerados para 39 tabelas e RPCs.

## Variaveis de ambiente Supabase

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_DB_URL` (kit HostGator para baseline/bootstrap)

Arquivos:

- `.env.example`
- `.env.hostgator.example`
- `Dockerfile`
- `hostgator-setup-kit/install.sh`
- `hostgator-setup-kit/update.sh`
- scripts de seed/QA/check que leem `.env.local`

## Auth e MFA

Acoplamentos principais:

- `supabase.auth.getUser()` e MFA em `lib/auth/server.ts`, `lib/auth/require-role.ts`, `lib/auth/requirePlatformAdmin.ts`.
- Server actions de auth em `app/actions/auth/*`.
- MFA TOTP e recovery em `app/(public)/login/mfa/page.tsx`, `app/actions/auth/enrollMfa.ts`, `confirmMfaEnroll.ts`, `verifyMfa.ts`, `useRecoveryCode.ts`.
- Admin API via `auth.admin` em scripts, bootstrap owner, team invite/enrichment e rotas admin.
- SQL referencia `auth.uid()` e `auth.users`.

Pontos SQL visiveis:

- `auth.uid()` em helpers/policies do `supabase/baseline.sql`.
- FKs para `auth.users` em tabelas como `user_organizations`, `platform_admins`, `conversation_assignment_events`, `ai_agent_versions`, `ai_provider_credentials` e outras colunas `created_by`/`sent_by_user_id`.

## Service role

`createAdminClient()` aparece em rotas, workers, libs e scripts. Usos relevantes:

- Webhooks WAHA e Nuvemshop.
- Cron endpoints.
- Workers IA/RAG/LGPD.
- Admin console.
- Onboarding e acoes de IA.
- Scripts de seed, bootstrap, QA e manutencao.

Risco central: service role bypassa RLS. O projeto tem convencao de filtrar `organization_id` manualmente, mas isso precisa virar teste de caracterizacao antes da migracao.

## RLS e policies

O SQL usa RLS em tabelas tenant-aware e policies nomeadas como:

- `tenant_isolation_*`
- `crm_pipelines_select`
- `crm_pipelines_manager_write`
- `crm_stages_select`
- `crm_stages_manager_write`
- `conversations_*`
- `messages_*`
- `crm_leads_*`
- `cae_*`
- storage policies para `ai-policy` e `lgpd-exports`

Helpers/funcoes relevantes:

- `fn_user_org_ids`
- `fn_is_platform_admin`
- `fn_member_role_in_org`
- `fn_can_view_conversation`
- `fn_can_view_lead`
- `fn_conversation_assign`
- `fn_attendant_metrics`

## RPCs e funcoes SQL chamadas pelo app

Chamadas encontradas em app/libs/workers:

- `fn_user_role_in_org`
- `fn_decrypt_oauth`
- `fn_encrypt_oauth`
- `encrypt_cpf`
- `fn_upsert_wa_contact`
- `fn_upsert_wa_conversation`
- `fn_mark_conversation_message`
- `fn_conversation_assign`
- `fn_lgpd_cascade_redact_contact`
- `fn_publish_ai_agent_version`
- `activate_kb_version`
- `retrieve_top_k_chunks`
- `jsonb_set_last_alarm_at`
- `emit_event`

Essas RPCs sao contrato de comportamento. Migrar apenas tabelas sem portar as funcoes quebra ingestao WAHA, IA, LGPD, audit/event log e RBAC.

## Realtime

Acoplamentos de Realtime:

- `hooks/realtime/useRealtimeChannel.ts`
- `hooks/useAlertsRealtime.ts`
- `hooks/useTenantHealth.ts`
- `hooks/useAdminInboxRealtime.ts`
- `hooks/inbox/useMessagesRealtime.ts`
- `hooks/inbox/useConversationsRealtime.ts`
- `hooks/kanban/useBoard.ts`
- `hooks/ai/useAgentRuns.ts`
- `lib/realtime/channels.ts`

SQL:

- `alter publication supabase_realtime add table ...` no baseline/apendices.
- Comentarios indicam tabelas como `messages`, `conversations`, `crm_leads`, `ai_agent_runs`, alerts/admin health.

Substituicao futura precisa decidir entre Postgres LISTEN/NOTIFY, WebSocket proprio, polling incremental ou outra camada realtime.

## Storage

Storage Supabase aparece em:

- SQL de buckets/policies para `ai-policy` e `lgpd-exports`.
- `lib/lgpd/storage-redaction-queue.ts`: remove objetos via `admin.storage`.
- Fluxos documentados de upload de midia WhatsApp por signed URL.
- Campos `media_storage_path` em `messages`.
- `storage_redaction_queue`.

Observacao: README fala em bucket privado `whatsapp-media`, mas o baseline auditado evidencia buckets/policies concretos para `ai-policy` e `lgpd-exports`; a midia WAHA ainda mistura `media_url`, `media_mime` e `media_storage_path`.

## Edge Functions

Nao foram encontrados arquivos de Edge Functions Supabase versionados. O projeto usa Next.js Route Handlers para APIs, webhooks e crons.

## Webhooks

Webhooks dependentes de Supabase/admin client:

- `app/api/v1/webhooks/waha/route.ts`
- `app/api/v1/webhooks/waha/[token]/route.ts`
- `app/api/v1/webhooks/nuvemshop/[event]/route.ts`
- `app/api/v1/webhooks/nuvemshop/customer-data-request/route.ts`
- `app/api/v1/webhooks/nuvemshop/customer-redact/route.ts`
- `app/api/v1/webhooks/nuvemshop/store-redact/route.ts`

WAHA resolve `channel_sessions`, valida/decripta HMAC por RPC, grava `webhook_events_log` e chama RPCs de upsert.

## Migrations e baseline

Artefatos:

- `supabase/baseline.sql`
- `supabase/migrations/*.sql`
- `supabase/migrations/MANIFEST.md`

Doutrina do projeto: migration versionada + linha no manifest + apendice idempotente no `baseline.sql`, porque o kit self-host aplica o baseline.

## Scripts

Scripts com Supabase/service role:

- `scripts/test-db.sh`
- `scripts/bootstrap-owner.ts`
- `scripts/create-test-user.ts`
- `scripts/check-user.ts`
- `scripts/check-roles.ts`
- `scripts/revoke-sessions.ts`
- `scripts/reset-user-onboarding.ts`
- `scripts/seed-e2e-credentials.ts`
- `scripts/seed-e2e-kanban.ts`
- `scripts/qa-wave-08.ts` a `qa-wave-12.ts`
- `scripts/inspect-source-schema.ts`

Kit HostGator:

- `install.sh`: aplica baseline via `psql`, cria usuario em Supabase Auth e promove admin.
- `update.sh`: reaplica baseline idempotente e atualiza stack.
- `backup.sh`: `pg_dump` de `SUPABASE_DB_URL` e snapshot WAHA.

## Ordem de migracao sugerida

1. Fixar baseline reproduzivel em Linux com pnpm 9, invariantes SQL e build.
2. Criar testes de caracterizacao para Auth/RBAC/MFA/RLS e service-role filtering.
3. Extrair camada de repositorios/transaction context sem trocar banco ainda.
4. Portar funcoes SQL criticas para Postgres proprio mantendo assinaturas.
5. Substituir Auth Supabase por modelo proprio/adapter, preservando MFA/recovery.
6. Substituir Realtime e Storage.
7. So entao remover pacotes/imports Supabase.

