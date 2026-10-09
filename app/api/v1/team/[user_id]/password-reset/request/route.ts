/**
 * POST /api/v1/team/[user_id]/password-reset/request
 *
 * Administra o PEDIDO de recuperação, não a senha global do auth.users.
 * Uma pessoa pode participar de múltiplas organizações: atualizar a senha via
 * service-role daria a um admin de tenant controle sobre contas de outros tenants.
 * O link de recuperação vai apenas para o e-mail do próprio membro, nunca ao admin.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { audit, isServiceRoleConfigured } from "@/lib/audit";
import { ok, fail } from "@/lib/api/wrappers";
import { authRateLimited, AUTH_LIMITS } from "@/lib/auth/rate-limit";
import { requireRole } from "@/lib/auth/require-role";
import { env } from "@/lib/env";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ user_id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "team" });
  if (!authz.ok) return authz.response;

  const { user_id: targetUserId } = await ctx.params;
  if (!z.string().uuid().safeParse(targetUserId).success) {
    return fail("validation_error", "Identificador de usuário inválido.", 400, { requestId });
  }
  if (targetUserId === authz.user.id) {
    return fail("state_conflict", "Para sua própria senha, use Recuperar senha no login.", 409, {
      requestId,
    });
  }

  const db = await createClient();
  const { data: member, error: membershipError } = await db
    .from("user_organizations")
    .select("id, user_id, accepted_at, revoked_at")
    .eq("organization_id", authz.org.orgId)
    .eq("user_id", targetUserId)
    .maybeSingle();
  if (membershipError) {
    return fail("internal_error", "Não foi possível consultar o vínculo.", 500, { requestId });
  }
  // Prova de pertencimento ANTES de qualquer lookup em auth.users.
  if (!member) return fail("not_found", "Membro não encontrado nesta empresa.", 404, { requestId });
  if (member.revoked_at || !member.accepted_at) {
    return fail("state_conflict", "O membro precisa estar ativo e com convite aceito.", 409, {
      requestId,
    });
  }

  if (!isServiceRoleConfigured()) {
    return fail("internal_error", "Serviço de recuperação indisponível.", 503, { requestId });
  }

  const admin = createAdminClient();
  const { data: account, error: userError } = await admin.auth.admin.getUserById(targetUserId);
  const email = account?.user?.email?.trim().toLowerCase();
  if (userError || !email) {
    return fail("state_conflict", "O usuário não possui e-mail recuperável.", 409, { requestId });
  }

  if (await authRateLimited("reset", email, AUTH_LIMITS.reset)) {
    return fail("rate_limited", "Limite de solicitações atingido. Tente mais tarde.", 429, {
      requestId,
    });
  }

  // Origem CANÔNICA configurada, não cabeçalho Origin/X-Forwarded-Host do pedido.
  const redirectTo = new URL("/auth/confirm?type=recovery", env.NEXT_PUBLIC_APP_URL).toString();
  const { error: resetError } = await db.auth.resetPasswordForEmail(email, { redirectTo });
  if (resetError) {
    return fail(
      resetError.status === 429 ? "rate_limited" : "internal_error",
      "Não foi possível enviar a recuperação agora. Verifique a configuração de e-mail.",
      resetError.status === 429 ? 429 : 503,
      { requestId },
    );
  }

  await audit({
    action: "team.password_reset_requested",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "membership",
    resourceId: member.id,
    requestId,
    metadata: { target_user_id: targetUserId, delivery: "gotrue_recovery_email" },
  });

  // Nem senha, nem token, nem link sensível aparecem nesta resposta.
  return ok({ user_id: targetUserId, requested: true }, { requestId });
}
