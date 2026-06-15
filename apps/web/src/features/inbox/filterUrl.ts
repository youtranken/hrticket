import type { TicketFilters, TicketSort, SortDir, TicketView } from '../../lib/tickets';

/**
 * (De)serialize the filter bar state to URL search params (Story 10.1) so a
 * filtered worklist is a shareable link. The BE Zod schema is the source of
 * truth for valid values; here we just parse/format strings.
 */
export function filtersFromParams(p: URLSearchParams): TicketFilters {
  const nums = (key: string): number[] | undefined => {
    const all = p.getAll(key).flatMap((v) => v.split(',')).map((v) => Number(v.trim())).filter((n) => Number.isFinite(n));
    return all.length ? all : undefined;
  };
  const strs = (key: string): string[] | undefined => {
    const all = p.getAll(key).flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
    return all.length ? all : undefined;
  };
  const view = p.get('view') as TicketView | null;
  const sort = p.get('sort') as TicketSort | null;
  const dir = p.get('dir') as SortDir | null;
  const projectId = p.get('projectId');
  return {
    view: view ?? undefined,
    sort: sort ?? undefined,
    dir: dir ?? undefined,
    status: strs('status'),
    categoryId: nums('categoryId'),
    tagId: nums('tagId'),
    assigneeId: strs('assigneeId'),
    projectId: projectId !== null ? Number(projectId) : undefined,
    createdFrom: p.get('createdFrom') ?? undefined,
    createdTo: p.get('createdTo') ?? undefined,
  };
}

export function paramsFromFilters(f: TicketFilters): URLSearchParams {
  const p = new URLSearchParams();
  // `view=all` is the default — keep the URL clean by omitting it.
  if (f.view && f.view !== 'all') p.set('view', f.view);
  if (f.sort && f.sort !== 'worklist') p.set('sort', f.sort);
  if (f.dir && f.dir !== 'desc') p.set('dir', f.dir);
  for (const s of f.status ?? []) p.append('status', s);
  for (const c of f.categoryId ?? []) p.append('categoryId', String(c));
  for (const t of f.tagId ?? []) p.append('tagId', String(t));
  for (const a of f.assigneeId ?? []) p.append('assigneeId', a);
  if (f.projectId !== undefined) p.set('projectId', String(f.projectId));
  if (f.createdFrom) p.set('createdFrom', f.createdFrom);
  if (f.createdTo) p.set('createdTo', f.createdTo);
  return p;
}
