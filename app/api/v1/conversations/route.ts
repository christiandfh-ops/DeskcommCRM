/**
 * GET /api/v1/conversations — list inbox com filtros + cursor pagination.
 *
 * Filtros suportados:
 *  - status: open | claimed | ai_handling | closed | archived
 *  - assigned_to: uuid | "me" | "unassigned"
 *  - channel_session_id: uuid
 *  - search: ILIKE em last_message_preview e nome/telefone do contato
 *
 * Multi-tenancy: usa cookie-scoped client; RLS garante isolamento.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { listConversationsQuerySchema } from "@/lib/schemas";
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

interface CursorPayload {
  last_message_at: string | null;
  id: string;
}

function encodeCursor(p: CursorPayload): string {
  return Buffer.from(JSON.stringify(p), "utf8").toString("base64url");
}

function decodeCursor(raw: string): CursorPayload | null {
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as CursorPayload;
    if (typeof parsed.id !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const supabase = await createClient();

  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }

  const url = new URL(req.url);
  const qsParsed = listConversationsQuerySchema.safeParse({
    status: url.searchParams.get("status") ?? undefined,
    assigned_to: url.searchParams.get("assigned_to") ?? undefined,
    channel_session_id: url.searchParams.get("channel_session_id") ?? undefined,
    search: url.searchParams.get("search") ?? undefined,
    cursor: url.searchParams.get("cursor") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });
  if (!qsParsed.success) {
    return fail("validation_failed", "Query inválida.", 422, {
      details: qsParsed.error.flatten().fieldErrors as Record<string, unknown>,
      requestId,
    });
  }
  const q = qsParsed.data;

  let query = supabase
    .from("conversations")
    .select(SELECT_COLS)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .order("id", { ascending: false })
    .limit(q.limit + 1);

  if (q.status) query = query.eq("status", q.status);
  if (q.channel_session_id) query = query.eq("channel_session_id", q.channel_session_id);

  if (q.assigned_to === "me") {
    query = query.eq("assigned_to_user_id", user.id);
  } else if (q.assigned_to === "unassigned") {
    query = query.is("assigned_to_user_id", null);
  } else if (q.assigned_to) {
    query = query.eq("assigned_to_user_id", q.assigned_to);
  }

  if (q.search) {
    const s = q.search.trim().replace(/[%_]/g, (m) => `\\${m}`);
    // Search in conversation preview only — joining contact ILIKE inside a
    // single PostgREST `or` chain is brittle; full-text via contact filters
    // is a follow-up.
    query = query.ilike("last_message_preview", `%${s}%`);
  }

  if (q.cursor) {
    const c = decodeCursor(q.cursor);
    if (!c) {
      return fail("invalid_cursor", "Cursor inválido.", 400, { requestId });
    }
    if (c.last_message_at) {
      query = query.or(
        `last_message_at.lt.${c.last_message_at},and(last_message_at.eq.${c.last_message_at},id.lt.${c.id})`,
      );
    } else {
      query = query.is("last_message_at", null).lt("id", c.id);
    }
  }

  const { data, error } = await query;
  if (error) {
    return fail("internal_error", error.message, 500, { requestId });
  }

  const rows = (data ?? []) as unknown as (Conversation & {
    contacts?: unknown;
  })[];
  const hasMore = rows.length > q.limit;
  const page = hasMore ? rows.slice(0, q.limit) : rows;
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last ? encodeCursor({ last_message_at: last.last_message_at, id: last.id }) : null;

  return ok(page, {
    requestId,
    meta: { cursor: nextCursor, has_more: hasMore },
  });
}
