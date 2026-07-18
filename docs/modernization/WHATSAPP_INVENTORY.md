# Inventario WhatsApp / WAHA - Fase 0

## Resumo

O WhatsApp atual e implementado via WAHA, com persistencia em Supabase/Postgres. A futura Meta API deve entrar por interfaces comuns, mas a Fase 0 nao implementa nem congela essas interfaces.

Contratos a preservar:

- sessao/canal por `channel_sessions`;
- ingestao idempotente de mensagens;
- resolucao de contato/conversa por organizacao;
- HMAC de webhook;
- eventos `message`, `message.any`, `message.ack`, `session.status`, `state.change`;
- envio outbound com registro em `messages`;
- audit/event log;
- STOP/PARAR/SAIR/UNSUBSCRIBE bloqueando contato;
- suporte a `@lid` e grupos ignorados para CRM binding.

## Variaveis e compose

Variaveis:

- `WAHA_API_BASE_URL`
- `WAHA_API_KEY`
- `WAHA_API_KEY_SHA512`
- `WAHA_WEBHOOK_BASE_URL`
- `WAHA_HMAC_SECRET`
- `WAHA_BYO_ENCRYPTION_KEY`
- `WAHA_IMAGE`
- `WAHA_DEFAULT_ENGINE`

`docker-compose.yml` dev:

- imagem `devlikeapro/waha-plus:latest`;
- `platform: linux/amd64`;
- eventos `message,message.any,message.ack,session.status,state.change`;
- webhook para `/api/v1/webhooks/waha`;
- volumes `waha-data` e `waha-media`.

`docker-compose.prod.yml`:

- imagem default `devlikeapro/waha`;
- rede interna, sem dashboard;
- `WAHA_API_KEY: "sha512:${WAHA_API_KEY_SHA512}"`;
- eventos iguais ao dev;
- volumes persistentes de sessao e midia.

## Codigo central

- `lib/waha/client.ts`: client REST WAHA (`startSession`, `stopSession`, `getSessionQr`, `sendMessage`).
- `lib/waha/send.ts`: resolve `chatId` e helper fino `sendWAHA`.
- `lib/waha/ingest.ts`: pipeline unico de webhook.
- `app/api/v1/messages/_handler.ts`: envio outbound pelo caminho de producao.
- `app/api/v1/webhooks/waha/route.ts`: webhook global por `body.session`.
- `app/api/v1/webhooks/waha/[token]/route.ts`: webhook canonico por token da sessao.
- `app/api/v1/channel-sessions/*`: CRUD/status/reconnect/QR de canais.
- `app/api/v1/onboarding/whatsapp/*`: fluxo legado/default de onboarding com `org_<8chars>`.
- `workers/ai-response-worker.ts` e `lib/ai/runtime/finalize.ts`: IA envia pelo `sendMessageHandler`.
- `lib/mcp/tools/messages.ts`: MCP reusa o mesmo handler.

## Modelo de dados envolvido

- `channel_sessions`: sessao WAHA, org, nome, status, token de webhook, segredo, telefone.
- `channel_session_warmup`: aquecimento/limites.
- `contacts`: identidade WhatsApp (`phone_number`, `wa_identity`, bloqueio STOP).
- `conversations`: contato + sessao + estado de atendimento.
- `messages`: inbound/outbound, `external_id`, `ack`, `media_url`, `media_storage_path`, status.
- `webhook_events_log`: raw body, headers, assinatura, status.
- `event_log`: dispara IA e workers.
- `conversation_assignment_events`: handoff/assign.

## Fluxo inbound

1. WAHA envia POST para `/api/v1/webhooks/waha` ou `/api/v1/webhooks/waha/[token]`.
2. Handler resolve `channel_sessions` por `waha_session_name` ou `webhook_path_token`.
3. Handler valida HMAC SHA512 quando consegue decriptar segredo.
4. Handler grava `webhook_events_log`.
5. `dispatchWahaEvent` roteia por tipo de evento.
6. Para `message`/`message.any` inbound:
   - ignora grupo;
   - parseia `@c.us`, `@s.whatsapp.net` ou `@lid`;
   - chama `fn_upsert_wa_contact`;
   - chama `fn_upsert_wa_conversation`;
   - insere `messages` com `organization_id`;
   - trata duplicidade `23505`;
   - atualiza conversa via `fn_mark_conversation_message`;
   - aplica STOP regex e audita;
   - emite `ai_agent.dispatch_requested`.

## Fluxo outbound

1. UI/API/MCP/IA chama `sendMessageHandler`.
2. Handler carrega `conversations` + `contacts` + `channel_sessions`.
3. Insere `messages` como `queued`.
4. Resolve chat WAHA:
   - grupo: `group_chat_id`;
   - telefone: `<digits>@c.us`;
   - LID: `<digits>@lid`.
5. Se WAHA ausente, deixa mensagem com `queued_reason`.
6. Se canal nao esta `WORKING`, deixa `queued_reason`.
7. Se pronto, chama `WAHA /api/sendText`.
8. Atualiza `messages` para `sent`, `external_id`, `ack`.
9. Atualiza preview/last message em `conversations`.
10. Audita `message.sent` e emite `event_log`.

## Interfaces futuras

A interface abaixo ainda nao deve ser tratada como definitiva. A proposta anterior estava moldada demais ao WAHA porque misturava provisionamento de canal (`startSession`, `stopSession`, `getQr`) com mensageria. Meta WhatsApp Cloud API nao usa QR/sessao WAHA; usa WABA, `phone_number_id`, tokens, Embedded Signup e templates.

Separacao recomendada:

### `MessagingProvider`

Responsavel por comportamento comum entre WAHA e Meta:

- envio de mensagens;
- verificacao de webhook;
- normalizacao de webhook para DTO canonico;
- status/ack de mensagens;
- identidade de contato/conversa;
- midia inbound/outbound;
- normalizacao de erros e codigos recuperaveis/permanentes;
- mapeamento de IDs externos para idempotencia.

### `ChannelProvisioner`

Responsavel por conectar, configurar e manter canais, aceitando capacidades diferentes por provedor:

- WAHA: sessao, start/stop/reconnect, QR, engine, health de sessao.
- Meta: WABA, `phone_number_id`, token, Embedded Signup, templates, assinatura/validacao de webhook e configuracao de app.

`MessagingProvider` e `ChannelProvisioner` nao devem conhecer Supabase. Eles devem devolver DTOs normalizados; repositorios do CRM persistem contatos, conversas, mensagens, canais e logs dentro de uma transacao com contexto de organizacao.

## Divergencias/risco WAHA atual

- Comentario em `lib/waha/client.ts` diz que `WAHA_API_KEY` local e hash; `docker-compose.prod.yml` usa container com hash e app mandando plaintext. Essa diferenca precisa teste de smoke por ambiente.
- Onboarding legado usa `org_<8chars>` e assume uma sessao default; `channel-sessions` novo ja suporta multi-numero com sufixo aleatorio.
- HMAC pode ser pulado se decriptacao falha ou seed dev usa placeholder. Em producao, isso deve ser configuracao explicita e testada.
- Midia nao esta completamente abstraida: existem `media_url`, `media_mime`, `media_storage_path` e storage-redaction separados.
- Grupos sao ignorados para CRM binding; Meta API precisa preservar ou redefinir essa regra.

## Laboratorio Meta recomendado

O laboratorio Meta deve acontecer antes de congelar as interfaces comuns. Fora do produto principal:

1. Criar app/lab isolado com numero de teste Meta.
2. Mapear webhook Meta para DTO normalizado equivalente a `WahaEnvelope`.
3. Validar envio de texto, status/ack, erros e rate limits.
4. Comparar IDs externos com idempotencia atual.
5. Comparar provisionamento Meta (WABA/phone number/templates/Embedded Signup) com WAHA (sessao/QR).
6. So depois congelar `MessagingProvider` e `ChannelProvisioner`.
