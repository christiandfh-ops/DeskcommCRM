import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  copy: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));

vi.mock("@/hooks/team/useInviteMembers", () => ({
  useInviteMembers: () => ({
    mutateAsync: mocks.mutate,
    isPending: false,
  }),
}));
vi.mock("@/lib/clipboard", () => ({ copyToClipboard: mocks.copy }));
vi.mock("sonner", () => ({
  toast: {
    success: mocks.success,
    error: mocks.error,
    info: mocks.info,
  },
}));

import { QuickInvitePanel } from "./QuickInvitePanel";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.copy.mockResolvedValue(true);
  mocks.mutate.mockResolvedValue({
    data: {
      sent: [
        {
          email: "pessoa@example.com",
          accept_url: "https://crm.example.com/accept?code=test-only",
          email_dispatched: false,
          expires_at: "2026-10-12T00:00:00Z",
        },
      ],
      failed: [],
    },
  });
});

describe("Novo usuário no painel do CRM", () => {
  it("mostra formulário inline com e-mail, perfil e criação de convite", () => {
    render(<QuickInvitePanel />);
    expect(screen.getByRole("heading", { name: "Novo usuário" })).toBeInTheDocument();
    expect(screen.getByLabelText("E-mail (login)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Criar convite" })).toBeInTheDocument();
    expect(screen.getByText(/A pessoa define sua própria senha/)).toBeInTheDocument();
  });

  it("cria convite de atendimento e oferece cópia se e-mail não saiu", async () => {
    const user = userEvent.setup();
    render(<QuickInvitePanel />);
    await user.type(screen.getByLabelText("E-mail (login)"), "PESSOA@EXAMPLE.COM");
    await user.click(screen.getByRole("button", { name: "Criar convite" }));
    await waitFor(() =>
      expect(mocks.mutate).toHaveBeenCalledWith({
        invitations: [
          {
            email: "pessoa@example.com",
            role: "agent",
            interface_settings: expect.any(Object),
          },
        ],
      }),
    );
    expect(await screen.findByText(/E-mail não enviado/)).toBeInTheDocument();
    expect(mocks.success).not.toHaveBeenCalledWith("Convite criado e e-mail enviado.");
    await user.click(screen.getByRole("button", { name: "Copiar link do convite" }));
    await waitFor(() =>
      expect(mocks.copy).toHaveBeenCalledWith("https://crm.example.com/accept?code=test-only"),
    );
  });

  it("não diz que entregou quando a API retorna falha", async () => {
    mocks.mutate.mockResolvedValue({
      data: { sent: [], failed: [{ email: "x@y.com", reason: "já existe" }] },
    });
    const user = userEvent.setup();
    render(<QuickInvitePanel />);
    await user.type(screen.getByLabelText("E-mail (login)"), "x@y.com");
    await user.click(screen.getByRole("button", { name: "Criar convite" }));
    await waitFor(() => expect(mocks.error).toHaveBeenCalled());
    expect(mocks.success).not.toHaveBeenCalled();
  });
});
