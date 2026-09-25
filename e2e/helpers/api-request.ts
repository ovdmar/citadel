import type { APIRequestContext } from "@playwright/test";

const ECONNRESET_RETRIES = 2;

type DeleteOptions = Parameters<APIRequestContext["delete"]>[1];
type GetOptions = Parameters<APIRequestContext["get"]>[1];
type PostOptions = Parameters<APIRequestContext["post"]>[1];
type PutOptions = Parameters<APIRequestContext["put"]>[1];

export function apiDelete(request: APIRequestContext, url: string, options?: DeleteOptions) {
  return request.delete(url, withConnectionResetRetries(options));
}

export function apiGet(request: APIRequestContext, url: string, options?: GetOptions) {
  return request.get(url, withConnectionResetRetries(options));
}

export function apiPost(request: APIRequestContext, url: string, options?: PostOptions) {
  return request.post(url, withConnectionResetRetries(options));
}

export function apiPut(request: APIRequestContext, url: string, options?: PutOptions) {
  return request.put(url, withConnectionResetRetries(options));
}

function withConnectionResetRetries<T extends { maxRetries?: number }>(options?: T): T & { maxRetries: number } {
  return { ...(options ?? ({} as T)), maxRetries: options?.maxRetries ?? ECONNRESET_RETRIES };
}
