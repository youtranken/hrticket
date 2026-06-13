/**
 * The active project an SSA is operating in (Story 1.8 AC3). Persisted so a
 * reload keeps the choice. Travels to the BE as the `X-Project` header on every
 * request; the BE validates it (a non-SSA sending a foreign project → 403).
 */
const KEY = 'hris.activeProject';

export function getActiveProject(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setActiveProject(projectKey: string | null): void {
  try {
    if (projectKey) localStorage.setItem(KEY, projectKey);
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable — header just won't be sent */
  }
}
