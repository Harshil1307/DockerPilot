import { AsyncLocalStorage } from 'node:async_hooks';

const authenticatedUserContext = new AsyncLocalStorage<string>();

export function runAsAuthenticatedUser(userId: string, next: () => void): void {
  authenticatedUserContext.run(userId, next);
}

export function currentAuthenticatedUserId(): string | undefined {
  return authenticatedUserContext.getStore();
}
