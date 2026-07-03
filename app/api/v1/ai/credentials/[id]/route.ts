/**
 * DELETE /api/v1/ai/credentials/:id (admin)
 *
 * Bloqueia se a credential é referenciada por uma `ai_agent_versions` que é a
 * `published_version_id` de algum agent não-arquivado da org.
 * Caso contrário, deleta. A FK ON DELETE RESTRICT é a última linha de defesa
 * (drafts não-publicadas também referenciam — preferimos erro 409 amigável).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authUser = await loadAuthUser();
  if (!authUser) return fail("unauthenticated", "Auth required.", 401, { requestId });
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) {
    return fail("forbidden_tenant", "Sem organização ativa.", 403, { requestId });
  }
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    return fail("forbidden_role", "Permissão insuficiente. Requer role admin.", 403, {
      requestId,
    });
  }

  const admin = createAdminClient();

  const { data: cred, error: fetchErr } = await admin
    .from("ai_provider_credentials")
    .select("id, organization_id, provider, label, api_key_last4")
    .eq("id", id)
    .maybeSingle();

  if (fetchErr) {
    return fail("internal_error", "Erro ao consultar credential.", 500, { requestId });
  }
  if (!cred || cred.organization_id !== activeOrg.orgId) {
    return fail("not_found", "Credential não encontrada.", 404, { requestId });
  }

  // Está referenciada por alguma versão que é published_version_id de agent ativo?
  const { data: linked, error: linkErr } = await admin
    .from("ai_agent_versions")
    .select(
      "id, agent_id, ai_agents!ai_agent_versions_agent_id_fkey!inner(id, archived_at, published_version_id)",
    )
    .eq("credential_id", id)
    .eq("organization_id", activeOrg.orgId);

  if (linkErr) {
    return fail("internal_error", "Erro ao verificar uso da credential.", 500, { requestId });
  }

  type LinkedVersion = {
    id: string;
    agent_id: string;
    ai_agents:
      | { id: string; archived_at: string | null; published_version_id: string | null }
      | { id: string; archived_at: string | null; published_version_id: string | null }[]
      | null;
  };

  const inUse = (linked ?? []).some((row: LinkedVersion) => {
    const agent = Array.isArray(row.ai_agents) ? row.ai_agents[0] : row.ai_agents;
    if (!agent || agent.archived_at) return false;
    return agent.published_version_id === row.id;
  });

  if (inUse) {
    return fail(
      "credential_in_use",
      "Credential é usada por uma versão publicada de agent. Despublique antes de deletar.",
      409,
      { requestId },
    );
  }

  const { error: delErr } = await admin
    .from("ai_provider_credentials")
    .delete()
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId);

  if (delErr) {
    if (delErr.code === "23503") {
      return fail(
        "credential_in_use",
        "Credential referenciada (FK ON DELETE RESTRICT). Remova as versões antes.",
        409,
        { requestId },
      );
    }
    return fail("internal_error", "Erro ao deletar credential.", 500, { requestId });
  }

  await audit({
    action: "ai.credential_deleted",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "ai_provider_credential",
    resourceId: id,
    requestId,
    metadata: { provider: cred.provider, label: cred.label, last4: cred.api_key_last4 },
  });

  return ok({ id, deleted: true }, { requestId });
}
