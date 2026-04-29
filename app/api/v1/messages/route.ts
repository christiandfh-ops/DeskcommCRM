/**
 * POST /api/v1/messages — envia mensagem outbound.
 *
 * Pipeline:
 *  1. Auth + Zod do payload (body OR media_url)
 *  2. Valida que conversation pertence à org do caller (RLS faz check, mas
 *     reconfirmamos manualmente para retornar 404 vs 500)
 *  3. INSERT mensagem em status='queued', sent_via='user'
 *  4. Tenta WAHA send via getWahaClient(). Se cliente null → fica queued
 *     com metadata.queued_reason='waha_not_configured' (worker reprocessa).
 *     Se WAHA disponível, sucesso → status='sent'+external_id+ack=0,
 *     falha → status='failed'+error_code/message.
 *  5. UPDATE conversation last_outbound_at + last_message_at + preview.
 *  6. Audit + emit_event.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { sendMessageSchema, validateRequest } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";
import type { Message } from "@/lib/types/messaging";
import { getWahaClient } from "@/lib/waha/client";

export const dynamic = "force-dynamic";

const MSG_COLS =
  "id, organization_id, conversation_id, channel_session_id, contact_id, external_id, type, direction, status, ack, error_code, error_message, body, media_url, media_mime, media_size_bytes, media_storage_path, sent_via, sent_by_user_id, sent_at, delivered_at, read_at, metadata, created_at";

function previewFrom(input: { body?: string; media_url?: string; type?: string }): string {
  if (input.body) return input.body.slice(0, 280);
  if (input.media_url) return `[${input.type ?? "media"}]`;
  return "";
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
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
    input = await validateRequest(sendMessageSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  // Resolve conversation + channel_session + contact (1 round-trip via select join).
  const { data: conv, error: convErr } = await supabase
    .from("conversations")
    .select(
      "id, organization_id, contact_id, channel_session_id, is_group, group_chat_id, contacts:contact_id(phone_number, is_blocked), channel_sessions:channel_session_id(waha_session_name, status)",
    )
    .eq("id", input.conversation_id)
    .maybeSingle();

  if (convErr) {
    return fail("internal_error", convErr.message, 500, { requestId });
  }
  if (!conv) {
    return fail("not_found", "Conversa não encontrada.", 404, { requestId });
  }

  type Joined = {
    id: string;
    organization_id: string;
    contact_id: string;
    channel_session_id: string;
    is_group: boolean;
    group_chat_id: string | null;
    contacts: { phone_number: string | null; is_blocked: boolean } | null;
    channel_sessions: { waha_session_name: string; status: string } | null;
  };
  const c = conv as unknown as Joined;

  if (c.contacts?.is_blocked) {
    return fail("forbidden", "Contato bloqueou o atendimento.", 403, { requestId });
  }

  const now = new Date().toISOString();
  const insertRow = {
    organization_id: c.organization_id,
    conversation_id: c.id,
    channel_session_id: c.channel_session_id,
    contact_id: c.contact_id,
    type: input.type,
    direction: "outbound" as const,
    status: "queued",
    body: input.body ?? null,
    media_url: input.media_url ?? null,
    media_mime: input.media_mime ?? null,
    sent_via: "user" as const,
    sent_by_user_id: user.id,
    sent_at: now,
    metadata: input.metadata ?? {},
  };

  const { data: created, error: insErr } = await supabase
    .from("messages")
    .insert(insertRow)
    .select(MSG_COLS)
    .single();

  if (insErr || !created) {
    return fail("internal_error", insErr?.message ?? "insert_failed", 500, { requestId });
  }
  let message = created as unknown as Message;

  // Try WAHA send
  const waha = getWahaClient();
  const phone = c.contacts?.phone_number;
  const chatId = c.is_group && c.group_chat_id ? c.group_chat_id : phone ? `${phone.replace(/\D/g, "")}@c.us` : null;

  if (!waha) {
    const { data: updated } = await supabase
      .from("messages")
      .update({
        metadata: { ...(message.metadata ?? {}), queued_reason: "waha_not_configured" },
      })
      .eq("id", message.id)
      .select(MSG_COLS)
      .maybeSingle();
    if (updated) message = updated as unknown as Message;
  } else if (!chatId) {
    const { data: updated } = await supabase
      .from("messages")
      .update({
        status: "failed",
        error_code: "missing_phone_number",
        error_message: "Contato sem telefone para envio WhatsApp.",
      })
      .eq("id", message.id)
      .select(MSG_COLS)
      .maybeSingle();
    if (updated) message = updated as unknown as Message;
  } else if (!c.channel_sessions || c.channel_sessions.status !== "WORKING") {
    const { data: updated } = await supabase
      .from("messages")
      .update({
        metadata: {
          ...(message.metadata ?? {}),
          queued_reason: "channel_session_not_working",
        },
      })
      .eq("id", message.id)
      .select(MSG_COLS)
      .maybeSingle();
    if (updated) message = updated as unknown as Message;
  } else {
    try {
      const wahaRes = (await waha.sendMessage(
        c.channel_sessions.waha_session_name,
        chatId,
        input.body ?? "",
      )) as { id?: string };
      const externalId = wahaRes?.id ?? null;
      const { data: updated } = await supabase
        .from("messages")
        .update({
          status: "sent",
          external_id: externalId,
          ack: 0,
        })
        .eq("id", message.id)
        .select(MSG_COLS)
        .maybeSingle();
      if (updated) message = updated as unknown as Message;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "waha_unknown";
      const { data: updated } = await supabase
        .from("messages")
        .update({
          status: "failed",
          error_code: "waha_error",
          error_message: msg,
        })
        .eq("id", message.id)
        .select(MSG_COLS)
        .maybeSingle();
      if (updated) message = updated as unknown as Message;
    }
  }

  // Atualiza last_outbound_at e preview na conversation (best-effort).
  await supabase
    .from("conversations")
    .update({
      last_outbound_at: now,
      last_message_at: now,
      last_message_preview: previewFrom({
        body: input.body,
        media_url: input.media_url,
        type: input.type,
      }),
    })
    .eq("id", c.id);

  await audit({
    action: "message.sent",
    actorUserId: user.id,
    organizationId: c.organization_id,
    resourceType: "message",
    resourceId: message.id,
    requestId,
    metadata: { status: message.status, type: message.type },
  });

  await supabase
    .rpc("emit_event", {
      p_event_type: "message.sent",
      p_entity_kind: "message",
      p_entity_id: message.id,
      p_payload: { status: message.status, conversation_id: c.id },
      p_metadata: { request_id: requestId },
      p_organization_id: c.organization_id,
    })
    .then(({ error }) => {
      if (error) console.error("[messages.send] emit_event failed", error.message);
    });

  return ok(message, { status: 201, requestId });
}
