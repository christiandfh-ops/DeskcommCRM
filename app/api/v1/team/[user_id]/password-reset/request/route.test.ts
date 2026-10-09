import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  support: vi.fn(),
  role: vi.fn(),
  member: vi.fn(),
  user: vi.fn(),
  reset: vi.fn(),
  limit: vi.fn(),
  audit: vi.fn(),
  orgFilter: vi.fn(),
  targetFilter: vi.fn(),
}));

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: mocks.support }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: mocks.role }));
vi.mock("@/lib/auth/rate-limit", () => ({
  authRateLimited: mocks.limit,
  AUTH_LIMITS: { reset: { ip: 30, id: 3, windowSec: 3600 } },
}));
vi.mock("@/lib/audit", () => ({
  audit: mocks.audit,
  isServiceRoleConfigured: () => true,
}));
vi.mock("@/lib/env", () => ({
  env: { NEXT_PUBLIC_APP_URL: "https://crm.example.com/" },
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ auth: { admin: { getUserById: mocks.user } } }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => ({
      select: () => ({
        eq: mocks.orgFilter,
      }),
    }),
    auth: { resetPasswordForEmail: mocks.reset },
  }),
}));

import { POST } from "./route";

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TARGET = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ORG = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function request() {
  return new NextRequest(
    "https://crm.example.com/api/v1/team/" + TARGET + "/password-reset/request",
    {
      method: "POST",
      headers: { origin: "https://attacker.example", "x-forwarded-host": "attacker.example" },
    },
  );
}
const ctx = (id = TARGET) => ({ params: Promise.resolve({ user_id: id }) });

function member(row: unknown) {
  mocks.member.mockResolvedValue({ data: row, error: null });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.support.mockResolvedValue(null);
  mocks.role.mockResolvedValue({ ok: true, user: { id: ADMIN }, org: { orgId: ORG } });
  mocks.orgFilter.mockImplementation(() => ({ eq: mocks.targetFilter }));
  mocks.targetFilter.mockImplementation(() => ({ maybeSingle: mocks.member }));
  member({
    id: "membership-1",
    user_id: TARGET,
    accepted_at: "2026-09-01T10:00:00Z",
    revoked_at: null,
  });
  mocks.user.mockResolvedValue({ data: { user: { email: "member@example.com" } }, error: null });
  mocks.limit.mockResolvedValue(false);
  mocks.reset.mockResolvedValue({ error: null });
  mocks.audit.mockResolvedValue(undefined);
});

describe("POST team/password-reset/request", () => {
  it("bloqueia suporte somente leitura antes de consultar membro", async () => {
    mocks.support.mockResolvedValue(new Response(null, { status: 403 }));
    expect((await POST(request(), ctx())).status).toBe(403);
    expect(mocks.role).not.toHaveBeenCalled();
    expect(mocks.member).not.toHaveBeenCalled();
  });

  it("rejeita quem não é admin", async () => {
    mocks.role.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });
    expect((await POST(request(), ctx())).status).toBe(403);
    expect(mocks.role).toHaveBeenCalledWith("admin", expect.anything());
    expect(mocks.member).not.toHaveBeenCalled();
  });

  it("proíbe reset de si mesmo", async () => {
    expect((await POST(request(), ctx(ADMIN))).status).toBe(409);
    expect(mocks.member).not.toHaveBeenCalled();
    expect(mocks.reset).not.toHaveBeenCalled();
  });

  it("rejeita id inválido sem efeitos colaterais", async () => {
    expect((await POST(request(), ctx("nao-uuid"))).status).toBe(400);
    expect(mocks.member).not.toHaveBeenCalled();
  });

  it("não permite consultar GoTrue se membro pertence a outro tenant", async () => {
    member(null);
    expect((await POST(request(), ctx(OTHER))).status).toBe(404);
    expect(mocks.orgFilter).toHaveBeenCalledWith("organization_id", ORG);
    expect(mocks.targetFilter).toHaveBeenCalledWith("user_id", OTHER);
    expect(mocks.user).not.toHaveBeenCalled();
    expect(mocks.reset).not.toHaveBeenCalled();
  });

  it.each([
    { revoked_at: "2026-01-01T00:00:00Z", accepted_at: "2025-01-01T00:00:00Z" },
    { revoked_at: null, accepted_at: null },
  ])("recusa vínculos inativos ou pendentes: %o", async (status) => {
    member({ id: "membership-1", ...status });
    expect((await POST(request(), ctx())).status).toBe(409);
    expect(mocks.user).not.toHaveBeenCalled();
  });

  it("recusa alvo sem email recuperável", async () => {
    mocks.user.mockResolvedValue({ data: { user: { email: null } }, error: null });
    expect((await POST(request(), ctx())).status).toBe(409);
    expect(mocks.reset).not.toHaveBeenCalled();
  });

  it("aplica rate limit antes de enviar", async () => {
    mocks.limit.mockResolvedValue(true);
    expect((await POST(request(), ctx())).status).toBe(429);
    expect(mocks.reset).not.toHaveBeenCalled();
  });

  it("erro no provedor não afirma sucesso nem audita envio", async () => {
    mocks.reset.mockResolvedValue({ error: { message: "SMTP is down", status: 500 } });
    const res = await POST(request(), ctx());
    expect(res.status).toBe(503);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("sucesso envia link ao próprio membro com URL canônica, registra audit sem senha nem token", async () => {
    const res = await POST(request(), ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data).toEqual({ user_id: TARGET, requested: true });
    expect(mocks.reset).toHaveBeenCalledWith("member@example.com", {
      redirectTo: "https://crm.example.com/auth/confirm?type=recovery",
    });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "team.password_reset_requested",
        organizationId: ORG,
        actorUserId: ADMIN,
        metadata: { target_user_id: TARGET, delivery: "gotrue_recovery_email" },
      }),
    );
    expect(JSON.stringify(json)).not.toContain("token");
    expect(JSON.stringify(json)).not.toContain("password");
  });
});
