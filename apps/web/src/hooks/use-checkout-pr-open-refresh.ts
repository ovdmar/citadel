import type { WorktreeCheckout } from "@citadel/contracts";
import type { QueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { api } from "../api.js";

export function checkoutPrRefreshIdentity(
  checkout: Pick<WorktreeCheckout, "intendedPr"> | null | undefined,
): string | null {
  const intendedPr = checkout?.intendedPr;
  return intendedPr?.number || intendedPr?.url
    ? [intendedPr.number ?? "", intendedPr.url ?? "", intendedPr.headSha ?? ""].join(":")
    : null;
}

export function useCheckoutPrOpenRefresh(input: {
  workspaceId: string | null | undefined;
  checkoutId: string | null;
  prIdentityKey?: string | null | undefined;
  queryClient: Pick<QueryClient, "invalidateQueries">;
}) {
  const primed = useRef(new Set<string>());
  useEffect(() => {
    if (!input.workspaceId || !input.checkoutId) return;
    const key = `${input.workspaceId}:${input.checkoutId}:${input.prIdentityKey ?? "initial"}`;
    if (primed.current.has(key)) return;
    primed.current.add(key);
    void api(`/api/workspaces/${input.workspaceId}/pr-refresh`, {
      method: "POST",
      body: JSON.stringify({ checkoutId: input.checkoutId }),
    })
      .then(() => {
        input.queryClient.invalidateQueries({ queryKey: ["workspaces-pr-state"] });
        input.queryClient.invalidateQueries({ queryKey: ["workspaces-pr-batch"] });
      })
      .catch(() => {});
  }, [input.workspaceId, input.checkoutId, input.prIdentityKey, input.queryClient]);
}
