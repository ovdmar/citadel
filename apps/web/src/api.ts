import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient();

export type ApiValidationIssue = {
  path: string;
  message: string;
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly issues: ApiValidationIssue[] = [],
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  if (!response.ok) throw await parseApiError(response);
  return response.json() as Promise<T>;
}

async function parseApiError(response: Response) {
  const text = await response.text();
  try {
    const body = JSON.parse(text) as { error?: string; issues?: ApiValidationIssue[] };
    return new ApiError(body.error || response.statusText, Array.isArray(body.issues) ? body.issues : []);
  } catch {
    return new ApiError(text || response.statusText);
  }
}
