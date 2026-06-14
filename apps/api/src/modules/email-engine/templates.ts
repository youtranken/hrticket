import { and, eq } from 'drizzle-orm';
import type { DbTx } from '../../infra/db/with-actor';
import { emailTemplates } from '../../infra/db/schema';

export type TemplateLang = 'vi' | 'en';

export interface RenderedTemplate {
  subject: string;
  bodyText: string;
  bodyHtml: string;
}

interface TemplateRow {
  subjectVi: string;
  subjectEn: string;
  bodyVi: string;
  bodyEn: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Replace `{{key}}` placeholders; `esc` decides HTML-escaping of the substituted value. */
function fill(template: string, vars: Record<string, string>, esc: boolean): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k: string) => {
    const v = vars[k] ?? '';
    return esc ? escapeHtml(v) : v;
  });
}

/**
 * Tiny template engine (FR10/FR53): placeholder substitution + HTML escaping.
 * Picks the language column, fills `{{ticketCode}}` etc. Reused by auto-ack (3.3),
 * reopen-locked notice, digests (Epic 6), and "test-send" (FR53).
 */
export function renderTemplate(
  tpl: TemplateRow,
  lang: TemplateLang,
  vars: Record<string, string>,
): RenderedTemplate {
  const subjectRaw = lang === 'en' ? tpl.subjectEn : tpl.subjectVi;
  const bodyRaw = lang === 'en' ? tpl.bodyEn : tpl.bodyVi;
  const subject = fill(subjectRaw, vars, false);
  const bodyText = fill(bodyRaw, vars, false);
  const bodyHtml = `<p>${fill(bodyRaw, vars, true).replace(/\n/g, '<br>')}</p>`;
  return { subject, bodyText, bodyHtml };
}

/** Load a project's template by key (returns null if not seeded). */
export async function loadTemplate(
  tx: DbTx,
  projectId: number,
  key: string,
): Promise<TemplateRow | null> {
  const [row] = await tx
    .select({
      subjectVi: emailTemplates.subjectVi,
      subjectEn: emailTemplates.subjectEn,
      bodyVi: emailTemplates.bodyVi,
      bodyEn: emailTemplates.bodyEn,
    })
    .from(emailTemplates)
    .where(and(eq(emailTemplates.projectId, projectId), eq(emailTemplates.key, key)));
  return row ?? null;
}
