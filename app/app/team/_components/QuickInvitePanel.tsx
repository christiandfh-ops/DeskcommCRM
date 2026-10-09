"use client";

import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "@/hooks/i18n/useT";
import { useInviteMembers } from "@/hooks/team/useInviteMembers";
import { INTERFACE_COMPLETA } from "@/lib/navigation/interface";
import { copyToClipboard } from "@/lib/clipboard";
import type { Role } from "@/lib/schemas/team";

type InviteCreated = {
  email: string;
  accept_url: string;
  email_dispatched: boolean;
  expires_at: string;
};

const PAPÉIS: { value: Role; label: string }[] = [
  { value: "viewer", label: "Visualização" },
  { value: "agent", label: "Atendimento" },
  { value: "manager", label: "Gerente" },
  { value: "admin", label: "Administrador" },
];

/**
 * Cadastro rápido no tenant atual. Usuários autenticam por e-mail no Supabase,
 * não por um nome de usuário/senha que o administrador consiga recuperar.
 * Uma conta pode ser membro de outras empresas, portanto NÃO criar/resetar
 * senhas globais neste formulário.
 */
export function QuickInvitePanel() {
  const t = useT();
  const invitation = useInviteMembers();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("agent");
  const [created, setCreated] = useState<InviteCreated | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const normalizedEmail = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      toast.error(t("Informe um e-mail válido."));
      return;
    }
    setCreated(null);
    try {
      const result = await invitation.mutateAsync({
        invitations: [{ email: normalizedEmail, role, interface_settings: INTERFACE_COMPLETA }],
      });
      const sent = result.data.sent[0];
      if (!sent) {
        toast.error(result.data.failed[0]?.reason || t("Não foi possível criar o convite."));
        return;
      }
      setCreated(sent);
      setEmail("");
      if (sent.email_dispatched) {
        toast.success(t("Convite criado e e-mail enviado."));
      } else {
        toast.info(t("Convite criado. O e-mail não foi enviado; copie o link abaixo."));
      }
    } catch {
      // useInviteMembers já exibe erro da API.
    }
  }

  async function copyInvite() {
    if (!created) return;
    const success = await copyToClipboard(created.accept_url);
    if (success) toast.success(t("Link do convite copiado."));
    else toast.error(t("Não foi possível copiar o link."));
  }

  return (
    <section className="rounded-xl border bg-card p-5 shadow-sm" aria-label={t("Novo usuário")}>
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{t("Novo usuário")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("Convide alguém para entrar na sua empresa no CRM.")}
        </p>
      </div>

      <form onSubmit={submit} className="mt-5 space-y-4">
        <div className="space-y-2">
          <Label htmlFor="quick-user-email">{t("E-mail (login)")}</Label>
          <Input
            id="quick-user-email"
            type="email"
            autoComplete="email"
            placeholder="usuario@empresa.com.br"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="quick-user-role">{t("Perfil")}</Label>
          <Select value={role} onValueChange={(value) => setRole(value as Role)}>
            <SelectTrigger id="quick-user-role" aria-label={t("Perfil do novo usuário")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAPÉIS.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {t(item.label)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {role === "admin" ? (
          <p className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs">
            {t("Administrador tem acesso às configurações e aos usuários da empresa.")}
          </p>
        ) : null}
        <Button type="submit" className="w-full" disabled={invitation.isPending}>
          {invitation.isPending ? t("Criando convite…") : t("Criar convite")}
        </Button>
      </form>

      {created ? (
        <div role="status" className="mt-4 space-y-2 rounded-md border bg-muted/30 p-3 text-sm">
          <p className="font-medium">
            {t("Convite criado para")} {created.email}
          </p>
          {created.email_dispatched ? (
            <p>{t("E-mail enviado. A pessoa precisa aceitar o convite.")}</p>
          ) : (
            <>
              <p className="text-amber-700 dark:text-amber-300">
                {t("E-mail não enviado. Compartilhe o link diretamente com o destinatário.")}
              </p>
              <Button type="button" size="sm" variant="outline" onClick={copyInvite}>
                {t("Copiar link do convite")}
              </Button>
            </>
          )}
        </div>
      ) : null}

      <p className="mt-4 text-xs text-muted-foreground">
        {t(
          "A pessoa define sua própria senha ao ativar o acesso. O administrador não recebe nem visualiza senhas.",
        )}
      </p>
      <Link
        href="/app/team/invite"
        className="mt-3 block text-sm font-medium text-primary underline-offset-4 hover:underline"
      >
        {t("Convidar vários usuários e personalizar áreas")} →
      </Link>
    </section>
  );
}
