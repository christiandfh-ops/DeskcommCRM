"use client";

import { useTeamMembers } from "@/hooks/team/useTeamMembers";
import { useTeamInvites } from "@/hooks/team/useTeamInvites";
import { useT } from "@/hooks/i18n/useT";

export function TeamAccessOverview() {
  const t = useT();
  const membersQuery = useTeamMembers();
  const invitesQuery = useTeamInvites();
  const members = membersQuery.data?.data ?? [];
  const invites = invitesQuery.data?.data ?? [];
  const active = members.filter((x) => !!x.accepted_at && !x.revoked_at).length;
  const pending = invites.filter((x) => x.status === "pendente").length;
  const undelivered = invites.filter((x) => x.status === "pendente" && !x.email_dispatched).length;

  const stats = [
    { title: t("Usuários ativos"), value: active, detail: t("Acessos aceitos") },
    { title: t("Convites pendentes"), value: pending, detail: t("Aguardando aceite") },
    { title: t("E-mails não enviados"), value: undelivered, detail: t("Copie o link na lista") },
  ];

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        {stats.map(({ title, value, detail }) => (
          <section key={title} className="rounded-xl border bg-card px-4 py-3 shadow-sm">
            <p className="text-xs font-medium text-muted-foreground">{title}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              {membersQuery.isLoading || invitesQuery.isLoading ? "…" : value}
            </p>
            <p className="text-xs text-muted-foreground">{detail}</p>
          </section>
        ))}
      </div>
      {undelivered > 0 ? (
        <p
          className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm"
          role="status"
        >
          {t(
            "Há convites sem envio por e-mail. Use “Copiar link” nos convites pendentes para entregar o acesso.",
          )}
        </p>
      ) : null}
    </div>
  );
}
