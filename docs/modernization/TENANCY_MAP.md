# Mapa Multiempresa - Fase 0

## Modelo atual

O projeto ja e multiempresa. Ele nasceu multi-tenant no schema Supabase, com `organization_id` como chave principal de isolamento, membership em `user_organizations` e super-admin transversal em `platform_admins`.

O objetivo da migracao nao e criar multi-tenancy do zero. O objetivo e preservar e endurecer o modelo existente em PostgreSQL proprio, mantendo RLS como barreira primaria e adicionando filtros em repositorios como defesa em profundidade.

## Tabelas tipadas

Fonte: `lib/database.types.ts`.

| Tabela | `organization_id` | Observacao de tenancy |
| --- | --- | --- |
| `ai_agent_runs` | obrigatorio | tenant-aware |
| `ai_agent_versions` | obrigatorio | tenant-aware, referencia usuario criador |
| `ai_agents` | obrigatorio | tenant-aware |
| `ai_budgets` | obrigatorio | tenant-aware |
| `ai_chunks` | obrigatorio | tenant-aware |
| `ai_faq_items` | obrigatorio | tenant-aware |
| `ai_invocations` | obrigatorio | tenant-aware |
| `ai_knowledge_sources` | obrigatorio | tenant-aware |
| `ai_knowledge_versions` | obrigatorio | tenant-aware |
| `ai_models` | ausente | catalogo global |
| `ai_pricing` | ausente | catalogo global |
| `ai_provider_credentials` | obrigatorio | tenant-aware, segredo cifrado |
| `api_audit_log` | nullable | plataforma + tenant; exige cuidado em queries admin |
| `api_tokens` | obrigatorio | tenant-aware |
| `channel_session_warmup` | obrigatorio | tenant-aware |
| `channel_sessions` | obrigatorio | tenant-aware; sessao WAHA por numero |
| `contacts` | obrigatorio | tenant-aware |
| `conversation_assignment_events` | obrigatorio | tenant-aware |
| `conversations` | obrigatorio | tenant-aware |
| `crm_lead_activities` | obrigatorio | tenant-aware |
| `crm_lead_links` | obrigatorio | tenant-aware |
| `crm_leads` | obrigatorio | tenant-aware |
| `crm_pipelines` | obrigatorio | tenant-aware |
| `crm_stages` | obrigatorio | tenant-aware |
| `event_log` | obrigatorio | tenant-aware |
| `idempotency_keys` | obrigatorio | tenant-aware |
| `incidents` | nullable | plataforma + tenant |
| `lgpd_requests` | obrigatorio | tenant-aware |
| `merge_queue` | obrigatorio | tenant-aware |
| `messages` | obrigatorio | tenant-aware |
| `nuvemshop_products` | obrigatorio | tenant-aware |
| `orders` | obrigatorio | tenant-aware |
| `organizations` | ausente | raiz do tenant |
| `platform_admins` | ausente | role transversal |
| `storage_redaction_queue` | obrigatorio | tenant-aware |
| `tenant_integrations` | obrigatorio | tenant-aware |
| `user_organizations` | obrigatorio | membership tenant/user |
| `user_recovery_codes` | ausente | escopo de usuario |
| `webhook_events_log` | nullable | eventos podem existir antes de atribuicao completa |

## Tabelas que nao devem receber `organization_id`

- `organizations`: e a propria entidade raiz.
- `platform_admins`: escopo transversal de administracao da plataforma.
- `user_recovery_codes`: pertence ao usuario, nao ao tenant; precisa de regra clara quando usuario participa de varias orgs.
- `ai_models` e `ai_pricing`: catalogos globais.

## Tabelas nullable que exigem policy explicita

- `api_audit_log.organization_id`
- `incidents.organization_id`
- `webhook_events_log.organization_id`

Essas tabelas misturam eventos globais/plataforma com eventos de tenant. A migracao deve exigir filtros explicitos por papel:

- usuario comum: apenas linhas da org ativa;
- platform admin: acesso transversal;
- sistema/worker: acesso via contexto transacional confiavel.

## Pontos de risco cross-tenant

1. `createAdminClient()` bypassa RLS em muitos handlers. Toda query precisa filtro manual de `organization_id`, exceto telas platform-admin intencionais.
2. Rotas admin acessam dados cross-tenant por design; precisam manter `requirePlatformAdmin`/MFA e auditoria.
3. WAHA global webhook resolve org por `waha_session_name`; colisao ou sessao nao registrada pode causar aceite sem persistencia.
4. WAHA token webhook resolve org por `webhook_path_token`; token e HMAC sao fontes confiaveis, nao o body.
5. `api_audit_log`, `incidents` e `webhook_events_log` permitem `organization_id` nulo; qualquer listagem deve separar plataforma de tenant.
6. Realtime depende da RLS Supabase. Ao sair do Supabase, o servidor WebSocket precisara aplicar o mesmo filtro de org por conexao e tambem depender de policies RLS no banco para leituras/escritas.
7. MCP e AI runtime usam admin client e contexto `organization_id`; qualquer tool que aceite IDs deve validar que o recurso pertence ao tenant do token.
8. Idempotencia deve continuar sempre composta por tenant quando envolver evento externo: ex. `unique (organization_id, external_id)`.

## Contexto transacional recomendado para Postgres proprio

O PostgreSQL proprio deve continuar usando RLS. Repositorios com filtros explicitos por `organization_id` sao uma segunda camada de defesa, nao substitutos da RLS.

Antes de substituir Supabase, criar uma camada que carregue e propague contexto transacional. Cada request, job, webhook, worker, cron e script operacional deve abrir uma transacao e executar `SET LOCAL` para os valores de escopo:

- `actor_user_id`
- `actor_type`
- `organization_id`
- `role`
- `is_platform_admin`
- `request_id`
- `source` (`web`, `api_token`, `webhook`, `cron`, `worker`, `script`)

Variaveis sugeridas:

```sql
set local app.user_id = '<uuid>';
set local app.organization_id = '<uuid>';
set local app.role = 'admin';
set local app.actor_type = 'user';
set local app.request_id = '<uuid>';
```

Policies devem consultar `current_setting(..., true)`, por exemplo:

```sql
current_setting('app.organization_id', true)::uuid
current_setting('app.user_id', true)::uuid
current_setting('app.role', true)
```

Essa camada deve ser obrigatoria em repositorios tenant-aware e deve impedir query sem escopo por default. Mesmo quando um repositorio filtrar `organization_id`, a policy RLS deve continuar rejeitando acesso se o contexto transacional estiver ausente, incoerente ou insuficiente.

## Primeira fatia de implementacao recomendada

1. `organizations`: manter a tabela raiz, status, onboarding, settings.
2. `users`: substituir dependencia direta de `auth.users` por tabela/app model proprio.
3. `memberships`: portar `user_organizations`, roles e accepted/revoked state.
4. `platform_admins`: manter separado, com MFA obrigatorio.
5. `transaction_context`: helper server-side para resolver org ativa, abrir transacao e aplicar `SET LOCAL`.
6. Testes de isolamento: dois tenants, usuarios cruzados, platform admin, service worker e API token.
7. So depois migrar `contacts`, `conversations`, `messages` e `channel_sessions`.

## Complexidade relativa

- Fundacao org/users/memberships/contexto: alta.
- Portar policies RLS para `current_setting()` + repositorios/testes: alta.
- CRM core (`contacts`, `conversations`, `messages`): alta.
- Catalogos globais (`ai_models`, `ai_pricing`): baixa.
- Audit/event log: media-alta por volume e por `organization_id` nullable.
- Admin console: media-alta por acesso transversal intencional.
