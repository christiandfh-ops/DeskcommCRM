"use client";
import { useEffect, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { createClient } from "@/lib/supabase/browser";
import type { TenantHealthResponse } from "@/app/api/v1/admin/tenants/[id]/health/route";

export type { TenantHealthResponse };

interface HealthApiResponse {
  data: TenantHealthResponse;
}

export function useTenantHealth(id: string) {
  const queryClient = useQueryClient();
  const queryKey = ["admin", "tenant", id, "health"] as const;

  const query = useQuery({
    queryKey,
    queryFn: () => apiClient.get<HealthApiResponse>(`/api/v1/admin/tenants/${id}/health`),
    staleTime: 30_000,
    refetchInterval: 60_000,
    enabled: !!id,
  });

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryClient, id]);

  // Realtime: subscribe to broadcast channel; any event triggers a refetch
  useEffect(() => {
    if (!id) return;
    const supabase = createClient();
    const channelName = `tenant-health-${id}`;
    const channel = supabase
      .channel(channelName)
      .on("broadcast", { event: "*" }, invalidate)
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [id, invalidate]);

  return query;
}
