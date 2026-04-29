/**
 * GET   /api/v1/conversations/[id] — single conversation + contact preview.
 * PATCH /api/v1/conversations/[id] — update status (claim shortcut quando
 *                                     status='claimed' assume o atendimento).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { updateConversationStatusSchema, validateRequest } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";
import type { Conversation } from "@/lib/types/messaging";

export const dynamic = "force-dynamic";

const SELECT_COLS = `
  id, organization_id, contact_id, channel_session_id, channel, status,
  status_changed_at, assigned_to_user_id, assigned_at, last_inbound_at,
  last_outbound_at, last_message_at, last_message_preview,
  unread_count_for_assignee, is_group, group_chat_id, metadata,
  created_at, updated_at,
  contacts:contact_id (id, display_name, name, phone_number, is_anonymized, tags, is_blocked)
`;

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  const supabase = await createClient();

  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }

  const { data, error } = await supabase
    .from("conversations")
    .select(SELECT_COLS)
    .eq("id", id)
    .maybeSingle();

  if (error) {
    return fail("internal_error", error.message, 500, { requestId });
  }
  if (!data) {
    return fail("not_found", "Conversa não encontrada.", 404, { requestId });
  }

  return ok(data as unknown as Conversation, { requestId });
}

export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  const supabase = await createClient();

  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }

  let input;
  try {
    input = await validateRequest(updateConversationStatusSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  const update: Record<string, unknown> = {
    status: input.status,
    status_changed_at: new Date().toISOString(),
  };
  // Atalho: status='claimed' assume o atendimento se ainda não há assignee.
  if (input.status === "claimed") {
    update.assigned_to_user_id = user.id;
    update.assigned_at = new Date().toISOString();
  }

  const { data, error } = await supabase
    .from("conversations")
    .update(update)
    .eq("id", id)
    .select(SELECT_COLS)
    .maybeSingle();

  if (error) {
    return fail("internal_error", error.message, 500, { requestId });
  }
  if (!data) {
    return fail("not_found", "Conversa não encontrada.", 404, { requestId });
  }

  const conv = data as unknown as Conversation;
  const action =
    input.status === "claimed"
      ? "conversation.claimed"
      : input.status === "closed"
        ? "conversation.closed"
        : "conversation.released";

  await audit({
    action,
    actorUserId: user.id,
    organizationId: conv.organization_id,
    resourceType: "conversation",
    resourceId: conv.id,
    requestId,
    metadata: { status: input.status },
  });

  return ok(conv, { requestId });
}
