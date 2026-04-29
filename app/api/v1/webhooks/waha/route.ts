/**
 * POST /api/v1/webhooks/waha — global webhook receiver (no path token).
 *
 * Used when WAHA is configured with a single global WHATSAPP_HOOK_URL across
 * all sessions (current docker-compose). Resolves the channel_session by
 * `body.session` (= channel_sessions.waha_session_name).
 *
 * The path-token variant at /api/v1/webhooks/waha/[token] remains the
 * canonical per-tenant route for production (each tenant gets a unique
 * webhook URL).
 *
 * Behaviour mirrors [token]/route.ts. Pipeline:
 *   1. Look up channel_sessions by waha_session_name (404 if unknown)
 *   2. Verify HMAC SHA512 against webhook_secret_encrypted
 *      (skip if dev seed has placeholder secret — logged)
 *   3. Route by event:
 *        - message / message.any  -> ingest inbound (or skip fromMe)
 *        - message.ack            -> update status/ack
 *        - session.status / state.change -> update channel_session.status
 *   4. Idempotency via UNIQUE (organization_id, external_id) on messages
 *   5. STOP keyword -> contact.is_blocked=true
 *   6. webhook_events_log row for audit/replay
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { ackToStatus } from "@/lib/types/messaging";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface WahaEnvelope {
  event?: string;
  session?: string;
  payload?: WahaPayload;
}

interface WahaPayload {
  id?: string;
  from?: string;
  to?: string;
  fromMe?: boolean;
  body?: string;
  type?: string;
  hasMedia?: boolean;
  ack?: number;
  ackName?: string;
  participant?: string;
  author?: string;
  status?: string;
  timestamp?: number;
  mediaUrl?: string;
  mimetype?: string;
}

const STOP_RX = /\b(STOP|PARAR|SAIR|UNSUBSCRIBE)\b/i;

function verifyHmacSha512(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): boolean {
  if (!signatureHeader) return false;
  const expected = createHmac("sha512", secret).update(rawBody, "utf8").digest("hex");
  const got = signatureHeader.replace(/^sha512=/i, "").trim();
  if (got.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(got, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

function previewFromMessage(p: WahaPayload): string {
  if (p.body) return p.body.slice(0, 280);
  if (p.type) return `[${p.type}]`;
  return "";
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  const rawBody = await req.text();
  let envelope: WahaEnvelope;
  try {
    envelope = JSON.parse(rawBody) as WahaEnvelope;
  } catch {
    return fail("invalid_request", "invalid_json", 400, { requestId });
  }

  const sessionName = envelope.session;
  if (!sessionName) {
    return fail("invalid_request", "missing session field", 400, { requestId });
  }

  const admin = createAdminClient();

  const { data: session, error: sessErr } = await admin
    .from("channel_sessions")
    .select(
      "id, organization_id, waha_session_name, webhook_secret_encrypted, status, is_warmup_complete, warmup_started_at",
    )
    .eq("waha_session_name", sessionName)
    .maybeSingle();

  if (sessErr) {
    return fail("internal_error", sessErr.message, 500, { requestId });
  }
  if (!session) {
    // Session not registered in our DB yet — accept and ignore (return 200 so
    // WAHA doesn't keep retrying). Common case: session was started via
    // dashboard before our app row was created.
    return ok({ accepted: false, reason: "session_not_registered", session: sessionName }, { requestId });
  }

  // HMAC verification — skip in dev when secret is the placeholder \x00.
  const sigHeader = req.headers.get("x-webhook-hmac") ?? req.headers.get("X-Webhook-Hmac");
  let validSignature = false;
  let hmacSkipped = false;
  try {
    const dec = await admin.rpc("fn_decrypt_oauth", {
      ciphertext: session.webhook_secret_encrypted,
    });
    if (dec.error || !dec.data || (typeof dec.data === "string" && dec.data.length < 4)) {
      hmacSkipped = true;
    } else {
      const secret = dec.data as string;
      validSignature = verifyHmacSha512(rawBody, sigHeader, secret);
    }
  } catch {
    hmacSkipped = true;
  }

  if (!hmacSkipped && !validSignature) {
    await audit({
      action: "nuvemshop.webhook_invalid_signature",
      organizationId: session.organization_id,
      metadata: { provider: "waha", session: session.waha_session_name, event: envelope.event },
    });
    return fail("unauthenticated", "invalid_signature", 401, { requestId });
  }

  const eventType = envelope.event ?? "unknown";
  const payload = envelope.payload ?? {};
  const externalId = payload.id ?? null;

  const headersJson: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    if (key.toLowerCase().startsWith("authorization")) return;
    if (key.toLowerCase() === "cookie") return;
    headersJson[key] = value;
  });
  await admin.from("webhook_events_log").insert({
    organization_id: session.organization_id,
    channel_session_id: session.id,
    provider: "waha",
    webhook_path_token: null,
    http_method: "POST",
    headers: headersJson,
    raw_body: rawBody,
    payload_parsed: envelope as unknown as Record<string, unknown>,
    signature_header: sigHeader ?? null,
    valid_signature: validSignature || hmacSkipped,
    event_type: eventType,
    external_id: externalId,
    status: "received",
    attempts: 0,
  });

  try {
    if (eventType === "message" || eventType === "message.any") {
      // Skip groups (chatId @g.us) — handled inside handler.
      // Treat fromMe=true as outbound (user replied directly from their
      // own WhatsApp app, not via our composer). Record so the operator
      // sees the manual reply alongside CRM-driven outbounds.
      if (payload.fromMe) {
        await handleOutboundFromUserPhone(admin, session, payload, requestId);
      } else {
        await handleInbound(admin, session, payload, requestId);
      }
    } else if (eventType === "message.ack") {
      await handleAck(admin, session, payload);
    } else if (eventType === "session.status" || eventType === "state.change") {
      await handleSessionStatus(admin, session, payload);
    }
  } catch (err) {
    console.error("[waha.webhook] handler failed", err);
  }

  return ok({ accepted: true }, { requestId });
}

async function handleInbound(
  admin: ReturnType<typeof createAdminClient>,
  session: { id: string; organization_id: string },
  p: WahaPayload,
  requestId: string,
): Promise<void> {
  const chatId = p.from ?? "";
  if (chatId.endsWith("@g.us")) return;
  // WhatsApp Multi-device usa @lid (Linked Identity) como pseudonymous ID
  // pra preservar privacidade. Não é phone E.164. Sem WAHA contact-resolve
  // (que requer chamada extra), não conseguimos criar um contato útil.
  // Skip por enquanto — quando a pessoa responder no @c.us regular, criamos.
  if (chatId.endsWith("@lid")) return;
  if (!p.id || !chatId) return;
  // Skip eventos sem conteúdo (WAHA emite muitos message events vazios pra
  // status updates, leituras, etc). Inbound real tem body OU media.
  if (!p.body && !p.mediaUrl && !p.hasMedia) return;

  const phone = "+" + chatId.replace(/@.*$/, "").replace(/^\+/, "");

  let contactId: string | null = null;
  const { data: existingContact } = await admin
    .from("contacts")
    .select("id, is_blocked")
    .eq("organization_id", session.organization_id)
    .eq("phone_number", phone)
    .maybeSingle();

  if (existingContact) {
    contactId = existingContact.id;
  } else {
    const { data: createdContact, error: contactErr } = await admin
      .from("contacts")
      .insert({
        organization_id: session.organization_id,
        phone_number: phone,
        source: "whatsapp",
        consent: {},
      })
      .select("id")
      .single();
    if (contactErr || !createdContact) {
      console.error("[waha.webhook] contact create failed", contactErr?.message);
      return;
    }
    contactId = createdContact.id;
  }

  let conversationId: string | null = null;
  const { data: existingConv } = await admin
    .from("conversations")
    .select("id, assigned_to_user_id, unread_count_for_assignee")
    .eq("organization_id", session.organization_id)
    .eq("contact_id", contactId)
    .eq("channel_session_id", session.id)
    .maybeSingle();

  if (existingConv) {
    conversationId = existingConv.id;
  } else {
    const { data: createdConv, error: convErr } = await admin
      .from("conversations")
      .insert({
        organization_id: session.organization_id,
        contact_id: contactId,
        channel_session_id: session.id,
        channel: "whatsapp",
        status: "open",
        is_group: false,
        unread_count_for_assignee: 0,
        metadata: {},
      })
      .select("id")
      .single();
    if (convErr || !createdConv) {
      console.error("[waha.webhook] conversation create failed", convErr?.message);
      return;
    }
    conversationId = createdConv.id;
  }

  const now = new Date().toISOString();
  const { error: insertErr } = await admin.from("messages").insert({
    organization_id: session.organization_id,
    conversation_id: conversationId,
    channel_session_id: session.id,
    contact_id: contactId,
    external_id: p.id,
    type: p.type ?? "text",
    direction: "inbound",
    status: "delivered",
    ack: p.ack ?? null,
    body: p.body ?? null,
    media_url: p.mediaUrl ?? null,
    media_mime: p.mimetype ?? null,
    sent_via: "external_device",
    sent_at: p.timestamp ? new Date(p.timestamp * 1000).toISOString() : now,
    delivered_at: now,
    metadata: { raw_type: p.type, ack_name: p.ackName },
  });

  if (insertErr && insertErr.code !== "23505") {
    console.error("[waha.webhook] message insert failed", insertErr.message);
    return;
  }
  if (insertErr?.code === "23505") return;

  await admin
    .from("conversations")
    .update({
      last_inbound_at: now,
      last_message_at: now,
      last_message_preview: previewFromMessage(p),
      unread_count_for_assignee: (existingConv?.unread_count_for_assignee ?? 0) + 1,
    })
    .eq("id", conversationId);

  if (p.body && STOP_RX.test(p.body)) {
    await admin
      .from("contacts")
      .update({
        is_blocked: true,
        blocked_reason: "stop_keyword",
        blocked_at: now,
      })
      .eq("id", contactId);
    await audit({
      action: "contact.blocked",
      organizationId: session.organization_id,
      resourceType: "contact",
      requestId,
      metadata: { reason: "stop_keyword", contact_id: contactId },
    });
  }

  await audit({
    action: "message.received",
    organizationId: session.organization_id,
    resourceType: "message",
    requestId,
    metadata: { conversation_id: conversationId, type: p.type, external_id: p.id },
  });
}

/**
 * fromMe=true: user sent a message DIRECTLY from their WhatsApp app (not via
 * our composer). Record as outbound so the operator sees what was sent.
 */
async function handleOutboundFromUserPhone(
  admin: ReturnType<typeof createAdminClient>,
  session: { id: string; organization_id: string },
  p: WahaPayload,
  requestId: string,
): Promise<void> {
  // For outbound (fromMe=true), recipient is in `to`. WAHA Multi-device
  // returns destinatário com `@lid` quando o destinatário ainda não está
  // nos contatos do remetente — sem phone E.164, não conseguimos linkar
  // a um contact válido. Skip por enquanto (mensagem ainda é registrada
  // no webhook_events_log pra replay futuro quando resolvermos LID→phone).
  const chatId = p.to ?? "";
  if (!chatId || chatId.endsWith("@g.us") || chatId.endsWith("@lid")) return;
  if (!p.id) return;
  if (!p.body && !p.mediaUrl && !p.hasMedia) return;

  const phone = "+" + chatId.replace(/@.*$/, "").replace(/^\+/, "");

  // Resolve contact by phone (don't auto-create — outbound to non-contact
  // is unusual; ignore if missing).
  const { data: contact } = await admin
    .from("contacts")
    .select("id")
    .eq("organization_id", session.organization_id)
    .eq("phone_number", phone)
    .maybeSingle();

  if (!contact) return;

  const { data: conv } = await admin
    .from("conversations")
    .select("id")
    .eq("organization_id", session.organization_id)
    .eq("contact_id", contact.id)
    .eq("channel_session_id", session.id)
    .maybeSingle();

  let conversationId = conv?.id ?? null;
  if (!conversationId) {
    const { data: createdConv } = await admin
      .from("conversations")
      .insert({
        organization_id: session.organization_id,
        contact_id: contact.id,
        channel_session_id: session.id,
        channel: "whatsapp",
        status: "open",
        is_group: false,
        unread_count_for_assignee: 0,
        metadata: {},
      })
      .select("id")
      .single();
    conversationId = createdConv?.id ?? null;
  }
  if (!conversationId) return;

  const now = new Date().toISOString();
  const { error: insertErr } = await admin.from("messages").insert({
    organization_id: session.organization_id,
    conversation_id: conversationId,
    channel_session_id: session.id,
    contact_id: contact.id,
    external_id: p.id,
    type: p.type ?? "text",
    direction: "outbound",
    status: "sent",
    ack: p.ack ?? null,
    body: p.body ?? null,
    media_url: p.mediaUrl ?? null,
    media_mime: p.mimetype ?? null,
    sent_via: "external_device", // user sent from their own phone, not CRM
    sent_at: p.timestamp ? new Date(p.timestamp * 1000).toISOString() : now,
    metadata: { raw_type: p.type, fromMe: true },
  });
  if (insertErr && insertErr.code !== "23505") {
    console.error("[waha.webhook] outbound insert failed", insertErr.message);
    return;
  }
  if (insertErr?.code === "23505") return;

  await admin
    .from("conversations")
    .update({
      last_outbound_at: now,
      last_message_at: now,
      last_message_preview: previewFromMessage(p),
    })
    .eq("id", conversationId);

  await audit({
    action: "message.sent",
    organizationId: session.organization_id,
    resourceType: "message",
    requestId,
    metadata: {
      conversation_id: conversationId,
      type: p.type,
      external_id: p.id,
      from_user_phone: true,
    },
  });
}

async function handleAck(
  admin: ReturnType<typeof createAdminClient>,
  session: { id: string; organization_id: string },
  p: WahaPayload,
): Promise<void> {
  if (!p.id) return;
  const ack = p.ack ?? 0;
  const status = ackToStatus(ack);
  const now = new Date().toISOString();

  const update: Record<string, unknown> = { ack, status };
  if (ack >= 2) update.delivered_at = now;
  if (ack >= 3) update.read_at = now;

  await admin
    .from("messages")
    .update(update)
    .eq("organization_id", session.organization_id)
    .eq("external_id", p.id);
}

async function handleSessionStatus(
  admin: ReturnType<typeof createAdminClient>,
  session: {
    id: string;
    organization_id: string;
    is_warmup_complete: boolean | null;
    warmup_started_at: string | null;
  },
  p: WahaPayload,
): Promise<void> {
  const status = (p.status ?? "").toUpperCase() || null;
  if (!status) return;

  const allowed = new Set(["STARTING", "SCAN_QR_CODE", "WORKING", "STOPPED", "FAILED"]);
  if (!allowed.has(status)) return;
  const now = new Date().toISOString();

  const update: Record<string, unknown> = {
    status,
    last_status_change_at: now,
  };

  if (status === "WORKING" && session.warmup_started_at && !session.is_warmup_complete) {
    update.is_warmup_complete = true;
    update.warmup_completed_at = now;
  }

  await admin.from("channel_sessions").update(update).eq("id", session.id);
}
