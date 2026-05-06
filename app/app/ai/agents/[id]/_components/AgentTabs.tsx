"use client";
/**
 * Tabs do detalhe de agent. Por enquanto só "Configuração" tem conteúdo;
 * Test, Runs e History serão entregues na Wave 12 (S-13.12).
 */
import * as React from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AgentForm, type ChannelSessionLite } from "./AgentForm";
import type { AgentRow } from "@/hooks/ai/useAgent";
import type { AgentVersionRow } from "@/hooks/ai/useAgentVersions";
import type { CredentialRow } from "@/hooks/ai/useCredentials";

interface Props {
  agent: AgentRow;
  draft: AgentVersionRow | null;
  published: AgentVersionRow | null;
  credentials: CredentialRow[];
  channelSessions: ChannelSessionLite[];
  readOnly?: boolean;
}

export function AgentTabs(props: Props) {
  return (
    <Tabs defaultValue="configuration" className="flex flex-col gap-4">
      <TabsList>
        <TabsTrigger value="configuration">Configuração</TabsTrigger>
        <TabsTrigger value="test" disabled>
          Teste
        </TabsTrigger>
        <TabsTrigger value="runs" disabled>
          Execuções
        </TabsTrigger>
        <TabsTrigger value="history" disabled>
          Histórico
        </TabsTrigger>
      </TabsList>

      <TabsContent value="configuration" className="m-0">
        <AgentForm mode="edit" {...props} />
      </TabsContent>

      <TabsContent value="test">
        <p className="text-sm text-muted-foreground">Tab Test será entregue na próxima wave.</p>
      </TabsContent>
      <TabsContent value="runs">
        <p className="text-sm text-muted-foreground">Tab Runs será entregue na próxima wave.</p>
      </TabsContent>
      <TabsContent value="history">
        <p className="text-sm text-muted-foreground">Tab History será entregue na próxima wave.</p>
      </TabsContent>
    </Tabs>
  );
}
