# Template Sumatex Demo

Este diretório registra a configuração reproduzível do agente de demonstração sem armazenar segredos, UUIDs de tenant, credenciais, sessões de WhatsApp ou dados pessoais.

## Sofia

`sofia.json` é o perfil-base para provisionar uma nova versão do agente.

A versão otimizada mantém CRM, catálogo, pedidos e rascunho de propostas. Ferramentas de agenda não entram por padrão porque a operação demonstrada pela Sumatex é comercial e não exige marcação de compromissos. Se um cliente contratar agenda, o provisionador acrescenta esse pacote ao agente daquele tenant.

Os limites de histórico e passos são conservadores para reduzir latência e contexto. A versão publicada no banco continua versionada; nunca se deve editar uma versão já publicada no lugar.
