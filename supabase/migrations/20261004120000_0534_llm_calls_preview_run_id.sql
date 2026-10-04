-- 0534 — correlaciona chamadas LLM de dry-run com ai_agent_runs.
--
-- Em produção real o run é job_queue.id e já existe llm_calls.job_id.
-- O botão "Testar agente" não cria job_queue (correto: não deve produzir efeitos
-- reais), então até aqui suas chamadas tinham job_id NULL e só o logger conhecia
-- preview_run_id. Isso tornava impossível somar tokens/custo de um teste de forma
-- determinística quando dois admins testassem ao mesmo tempo.
alter table public.llm_calls
  add column if not exists preview_run_id uuid
  references public.ai_agent_runs(id) on delete set null;

create index if not exists idx_llm_calls_preview_run_id
  on public.llm_calls (preview_run_id)
  where preview_run_id is not null;

comment on column public.llm_calls.preview_run_id is
  'ai_agent_runs.id somente para dry-run/preview. Em turnos reais permanece NULL; '
  'job_id continua sendo o vínculo canônico com job_queue.';
