export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

import { getActiveProject } from './activeProject';

/** Fetch wrapper: always sends cookies, surfaces {code,message}, redirects on 401. */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const activeProject = getActiveProject();
  const res = await fetch(`/api${path}`, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      // SSA active-project selector — the BE gate enforces who may use it.
      ...(activeProject ? { 'X-Project': activeProject } : {}),
      ...(init.headers ?? {}),
    },
    ...init,
  });

  if (res.status === 401 && !path.startsWith('/auth/login') && !path.startsWith('/me')) {
    // Preserve where the user was so login can bounce back (Story 1.4 deep-link).
    const returnUrl = window.location.pathname + window.location.search;
    window.location.assign(`/login?returnUrl=${encodeURIComponent(returnUrl)}`);
  }

  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const message =
      typeof body.message === 'string' ? body.message : `Request failed (${res.status})`;
    const code = typeof body.code === 'string' ? body.code : 'HTTP_ERROR';
    throw new ApiError(res.status, code, message);
  }
  return body as T;
}
