import type { ProviderId } from '@/core/ai/types';

// Only live cancellation handles are kept here. Durable claims and consent
// remain in storage; after a worker restart there are no live requests to stop.
const requests = new Map<string, { controller: AbortController; providerId: ProviderId; sessionId?: string }>();

export function registerCloudRequest(key: string, providerId: ProviderId, sessionId?: string): AbortController {
  const controller = new AbortController();
  requests.set(key, { controller, providerId, ...(sessionId ? { sessionId } : {}) });
  return controller;
}

export function releaseCloudRequest(key: string, controller: AbortController): void {
  if (requests.get(key)?.controller === controller) requests.delete(key);
}

export function abortCloudRequests(providerId?: ProviderId): void {
  for (const request of requests.values()) {
    if (request.providerId !== 'chrome-local' && (!providerId || request.providerId === providerId))
      request.controller.abort();
  }
}

export function hasActiveRequest(key: string): boolean { return requests.has(key); }
export function abortSessionRequests(sessionId: string): void {
  for (const request of requests.values()) if (request.sessionId === sessionId) request.controller.abort();
}
