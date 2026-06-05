export function deployedAppsQueryKey(workspaceId: string, checkoutId: string | null | undefined) {
  return ["deployed-apps", workspaceId, checkoutId ?? "home"] as const;
}

export function deployedAppsUrl(workspaceId: string, checkoutId: string | null | undefined) {
  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}/deployed-apps`;
  return checkoutId ? `${base}?checkoutId=${encodeURIComponent(checkoutId)}` : base;
}

export function deployedAppActionPayload(name: string | undefined, checkoutId: string | null | undefined) {
  return {
    ...(name ? { name } : {}),
    ...(checkoutId ? { checkoutId } : {}),
  };
}

export const redeployPayload = deployedAppActionPayload;
export const undeployPayload = deployedAppActionPayload;
