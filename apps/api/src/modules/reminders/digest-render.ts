import { sortWorklist, type WorklistItem } from '@hris/shared';

export interface DigestTicket extends WorklistItem {
  ticketCode: string;
  subject: string;
  categoryId: number | null;
  categoryLabel: string;
  ageDays: number;
}

export interface DigestRenderInput {
  recipientName: string;
  tickets: DigestTicket[];
  maxN: number;
  baseUrl: string;
  /** Admin-only "🗑 N in Junk" line (FR/C1); omitted when undefined. */
  junkCount?: number;
  /** Intro/outro text from the editable `digest` template (already rendered). */
  introHtml?: string;
  introText?: string;
}

export interface DigestBody {
  bodyHtml: string;
  bodyText: string;
  /** Number of tickets actually listed (after the N cap). */
  shown: number;
  total: number;
}

/**
 * Render a recipient's daily digest (FR49). Tickets are sorted by the shared
 * worklist order, capped at N (the rest summarised as "…and X more"), then grouped
 * by category for display. Each line carries a deep link to the ticket. Bilingual:
 * `lang` picks the wording; the category label is pre-resolved by the caller.
 */
export function renderDigest(input: DigestRenderInput, lang: 'vi' | 'en'): DigestBody {
  const sorted = sortWorklist(input.tickets) as DigestTicket[];
  const total = sorted.length;
  const kept = sorted.slice(0, input.maxN);
  const overflow = total - kept.length;

  // Group the kept tickets by category, preserving worklist order within each group.
  const groups = new Map<string, DigestTicket[]>();
  for (const t of kept) {
    const arr = groups.get(t.categoryLabel) ?? [];
    arr.push(t);
    groups.set(t.categoryLabel, arr);
  }

  const L =
    lang === 'en'
      ? { overdue: 'overdue', days: 'd', more: 'more ticket(s)', junk: 'in Junk', age: 'age' }
      : { overdue: 'quá hạn', days: 'ngày', more: 'ticket khác', junk: 'trong Junk', age: 'tuổi' };

  const htmlParts: string[] = [];
  const textParts: string[] = [];
  for (const [cat, list] of groups) {
    htmlParts.push(`<h4 style="margin:12px 0 4px">${esc(cat)}</h4><ul style="margin:0;padding-left:18px">`);
    textParts.push(`\n${cat}`);
    for (const t of list) {
      const link = `${input.baseUrl}/tickets/${t.id}`;
      const flag = t.isOverdue ? ` — ${L.overdue} ${t.overdueDays}${L.days}` : '';
      htmlParts.push(
        `<li><a href="${link}">${esc(t.ticketCode)}</a> ${esc(t.subject)} <span style="color:#888">(${L.age} ${t.ageDays}${L.days}${flag})</span></li>`,
      );
      textParts.push(`  ${t.ticketCode} ${t.subject} (${L.age} ${t.ageDays}${L.days}${flag}) ${link}`);
    }
    htmlParts.push('</ul>');
  }
  if (overflow > 0) {
    htmlParts.push(`<p style="color:#888">…+${overflow} ${L.more}</p>`);
    textParts.push(`\n…+${overflow} ${L.more}`);
  }
  if (input.junkCount !== undefined && input.junkCount > 0) {
    htmlParts.push(`<p>🗑 ${input.junkCount} ${L.junk}</p>`);
    textParts.push(`\n🗑 ${input.junkCount} ${L.junk}`);
  }

  const intro = input.introHtml ? `<p>${input.introHtml}</p>` : '';
  const introT = input.introText ? `${input.introText}\n` : '';
  return {
    bodyHtml: `${intro}${htmlParts.join('\n')}`,
    bodyText: `${introT}${textParts.join('\n')}`.trim(),
    shown: kept.length,
    total,
  };
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
