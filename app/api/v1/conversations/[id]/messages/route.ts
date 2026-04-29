/**
 * GET /api/v1/conversations/[id]/messages — histórico de mensagens da conversa.
 *
 * Order: sent_at ASC (chat order). Cursor pagination carrega mensagens mais
 * antigas em chunks de até 100.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { listMessagesQuerySchema } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";
import type { Message } from "@/lib/types/messaging";

export const dynamic = "force-dynamic";

const SELECT_COLS =
  "id, organization_id, conversation_id, channel_session_id, contact_id, external_id, type, direction, status, ack, error_code, error_message, body, media_url, media_mime, media_size_bytes, media_storage_path, sent_via, sent_by_user_id, sent_at, delivered_at, read_at, metadata, created_at";

interface CursorPayload {
  sent_at: string;
  id: string;
}

function encodeCursor(p: CursorPayload): string {
  return Buffer.from(JSON.stringify(p), "utf8").toString("base64url");
}

function decodeCursor(raw: string): CursorPayload | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as CursorPayload;
    if (typeof parsed.id !== "string" || typeof parsed.sent_at !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id: conversationId } = await ctx.params;
  const supabase = await createClient();

  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }

  const url = new URL(req.url);
  const qsParsed = listMessagesQuerySchema.safeParse({
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
    .from("messages")
    .select(SELECT_COLS)
    .eq("conversation_id", conversationId)
    .order("sent_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(q.limit + 1);

  if (q.cursor) {
    const c = decodeCursor(q.cursor);
    if (!c) {
      return fail("invalid_cursor", "Cursor inválido.", 400, { requestId });
    }
    query = query.or(`sent_at.gt.${c.sent_at},and(sent_at.eq.${c.sent_at},id.gt.${c.id})`);
  }

  const { data, error } = await query;
  if (error) {
    return fail("internal_error", error.message, 500, { requestId });
  }

  const rows = (data ?? []) as unknown as Message[];
  const hasMore = rows.length > q.limit;
  const page = hasMore ? rows.slice(0, q.limit) : rows;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor({ sent_at: last.sent_at, id: last.id }) : null;

  return ok(page, { requestId, meta: { cursor: nextCursor, has_more: hasMore } });
}
