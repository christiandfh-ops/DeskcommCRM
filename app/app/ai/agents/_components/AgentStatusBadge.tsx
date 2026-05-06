"use client";
import { Badge } from "@/components/ui/badge";
import type { AgentRow } from "@/hooks/ai/useAgent";

export type AgentStatus = "published" | "draft" | "paused" | "archived" | "invalid";

export function deriveAgentStatus(agent: AgentRow): AgentStatus {
  if (agent.archived_at) return "archived";
  if (agent.kind === "mcp_agent") {
    if (agent.published_version_id) return "published";
    return "paused";
  }
  return agent.is_active ? "published" : "paused";
}

const LABEL: Record<AgentStatus, string> = {
  published: "Publicado",
  draft: "Rascunho",
  paused: "Pausado",
  archived: "Arquivado",
  invalid: "Inválido",
};

const VARIANT: Record<AgentStatus, "default" | "secondary" | "outline" | "destructive"> = {
  published: "default",
  draft: "secondary",
  paused: "outline",
  archived: "outline",
  invalid: "destructive",
};

export function AgentStatusBadge({ status }: { status: AgentStatus }) {
  return (
    <Badge variant={VARIANT[status]} aria-label={`status: ${LABEL[status]}`}>
      {LABEL[status]}
    </Badge>
  );
}
