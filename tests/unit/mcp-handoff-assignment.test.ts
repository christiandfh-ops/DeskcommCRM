/**
 * G3-02 acceptance 2 — crm_request_human_handoff grava o assignment event
 * (reason='handoff') e move kind ai→user/fila conforme o roteamento vigente
 * (round-robin agent+ que o handoff já tinha).
 *
 * Prova, contra a tool REAL (ctx.supabase mockado, triggerHandoff mockado):
 *  - com elegível: rpc fn_conversation_assign com p_reason='handoff' (evento +
 *    kind='user' saem da função, na mesma transação);
 *  - sem elegível: fila — assignee_kind limpo (null) + INSERT direto do evento
 *    reason='handoff' com from/to/changed_by null (sistema).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { triggerHandoff } from "@/lib/ai/handoff/orchestrator";
import { crmRequestHumanHandoff } from "@/lib/mcp/tools/handoff";
import type { McpContext } from "@/lib/mcp/types";

vi.mock("@/lib/ai/handoff/orchestrator", () => ({ triggerHandoff: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const CONV_ID = "44444444-4444-4444-8444-444444444444";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";

interface StubState {
  members: Array<{ user_id: string; role: string }>;
  rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>;
  updates: Array<{ table: string; values: Record<string, unknown> }>;
  inserts: Array<{ table: string; values: Record<string, unknown> }>;
}

function makeSupabaseStub(state: StubState) {
  const from = (table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      is: () => chain,
      in: () =>
        // user_organizations round-robin query termina em .in(...)
        Promise.resolve({ data: state.members, error: null }),
      order: () => chain,
      limit: () => chain,
      maybeSingle: () =>
        Promise.resolve({
          data:
            table === "conversations"
              ? { id: CONV_ID, organization_id: ORG_ID, contact_id: null }
              : null,
          error: null,
        }),
      update: (values: Record<string, unknown>) => {
        state.updates.push({ table, values });
        return chain;
      },
      insert: (values: Record<string, unknown>) => {
        state.inserts.push({ table, values });
        return Promise.resolve({ data: null, error: null });
      },
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: null, error: null }).then(resolve),
    };
    return chain;
  };
  return {
    from,
    rpc: (fn: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ fn, args });
      return Promise.resolve({ data: [{ id: CONV_ID }], error: null });
    },
  };
}

function makeCtx(state: StubState): McpContext {
  return {
    organizationId: ORG_ID,
    role: "agent",
    actor: { type: "user", id: AGENT_ID },
    apiTokenId: "tok",
    requestId: "req",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: makeSupabaseStub(state) as any,
  } as McpContext;
}

function stubState(overrides: Partial<StubState> = {}): StubState {
  return {
    members: [{ user_id: AGENT_ID, role: "agent" }],
    rpcCalls: [],
    updates: [],
    inserts: [],
    ...overrides,
  };
}

const input = {
  conversation_id: CONV_ID,
  reason: "cliente pediu humano",
  urgency: "normal" as const,
  suggested_assignee_role: "agent" as const,
  metadata: undefined,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(triggerHandoff).mockResolvedValue({ triggered: true, reason: "requested_human" });
});

describe("crm_request_human_handoff — reassignment auditado (G3-02)", () => {
  it("com elegível: fn_conversation_assign com reason='handoff' (kind ai→user + evento na fn)", async () => {
    const state = stubState();
    const result = (await crmRequestHumanHandoff.handler(input, makeCtx(state))) as {
      assigned_to_user_id: string | null;
    };

    expect(state.rpcCalls).toEqual([
      {
        fn: "fn_conversation_assign",
        args: {
          p_organization_id: ORG_ID,
          p_conversation_id: CONV_ID,
          p_to_user_id: AGENT_ID,
          p_reason: "handoff",
          p_enforce_expected: false,
        },
      },
    ]);
    expect(result.assigned_to_user_id).toBe(AGENT_ID);
    // Caminho da fila NÃO roda quando a atribuição venceu.
    expect(state.inserts).toEqual([]);
  });

  it("sem elegível: fila — kind limpo + evento reason='handoff' from/to null (sistema)", async () => {
    const state = stubState({ members: [] });
    const result = (await crmRequestHumanHandoff.handler(input, makeCtx(state))) as {
      assigned_to_user_id: string | null;
    };

    expect(result.assigned_to_user_id).toBeNull();
    expect(state.rpcCalls).toEqual([]);
    expect(state.updates).toContainEqual({
      table: "conversations",
      values: { assignee_kind: null },
    });
    expect(state.inserts).toContainEqual({
      table: "conversation_assignment_events",
      values: {
        organization_id: ORG_ID,
        conversation_id: CONV_ID,
        from_user_id: null,
        to_user_id: null,
        changed_by: null,
        reason: "handoff",
      },
    });
  });
});
