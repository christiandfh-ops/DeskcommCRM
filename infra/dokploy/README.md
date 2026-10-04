# Deploy LCtech no Dokploy

Este diretório guarda a configuração reproduzível usada pelo CRM hospedado no Dokploy.

## Regra operacional

- O código-fonte vive no Git e as imagens Docker são artefatos do mesmo commit.
- Segredos não entram no repositório; ficam no ambiente do Dokploy.
- O `app` atende HTTP.
- O `worker` é obrigatório em produção: consome a fila do agent-engine, executa turnos reais, follow-ups e rotinas assíncronas.
- Redis/SRH e WAHA continuam serviços separados.
- O banco é o Supabase externo conectado pela rede `supabase_private`.

## Imagens

Defina explicitamente no ambiente do Dokploy:

- `APP_IMAGE`
- `WORKER_IMAGE`

Durante estabilização podem apontar para uma tag de branch do GHCR da LCtech. Em produção, promova somente uma imagem cujo app e worker tenham sido construídos do mesmo commit.

## Antes de subir

1. `docker compose -f infra/dokploy/docker-compose.crm.yml config --quiet`
2. Confirmar que `AI_CRED_AES_KEY`, chaves Supabase, WAHA e segredos internos estão apenas no ambiente.
3. Confirmar que `SUPABASE_DB_ADMIN_URL` não é entregue ao worker.
4. Subir app e worker da mesma revisão.
5. Validar `/healthz` do worker e o healthcheck do app.
6. Fazer um dry-run da Sofia e depois um teste controlado no WhatsApp.

Nunca versionar o arquivo `.env` de produção.
