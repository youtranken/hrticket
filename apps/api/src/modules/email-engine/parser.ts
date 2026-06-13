import { simpleParser, type AddressObject } from 'mailparser';

export interface ParsedAddress {
  address: string;
  name?: string;
}

export interface ParsedAttachment {
  filename: string;
  contentType: string;
  size: number;
  content: Buffer;
}

export interface ParsedMail {
  from: ParsedAddress | null;
  to: ParsedAddress[];
  cc: ParsedAddress[];
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  date: Date | null;
  /** Lowercased header name → raw value; used by the anti-loop detector (2.4). */
  headers: Map<string, string>;
  attachments: ParsedAttachment[];
}

function addrs(a: AddressObject | AddressObject[] | undefined): ParsedAddress[] {
  if (!a) return [];
  const list = Array.isArray(a) ? a : [a];
  return list.flatMap((o) =>
    (o.value ?? [])
      .filter((v) => v.address)
      .map((v) => ({ address: v.address!.toLowerCase(), name: v.name || undefined })),
  );
}

/** Parse a raw RFC822 message into a normalized shape. email-engine only parses — it
 *  knows nothing about tickets (the intake orchestrator wires parse → create/append). */
export async function parseMail(raw: string): Promise<ParsedMail> {
  const p = await simpleParser(raw);
  const from = addrs(p.from)[0] ?? null;
  const references = Array.isArray(p.references)
    ? p.references
    : p.references
      ? [p.references]
      : [];

  const headers = new Map<string, string>();
  for (const [k, v] of p.headers) {
    headers.set(k.toLowerCase(), typeof v === 'string' ? v : JSON.stringify(v));
  }

  return {
    from,
    to: addrs(p.to),
    cc: addrs(p.cc),
    subject: p.subject ?? '(no subject)',
    bodyText: p.text ?? '',
    bodyHtml: typeof p.html === 'string' ? p.html : null,
    messageId: p.messageId ?? null,
    inReplyTo: p.inReplyTo ?? null,
    references,
    date: p.date ?? null,
    headers,
    attachments: (p.attachments ?? []).map((a) => ({
      filename: a.filename ?? 'attachment',
      contentType: a.contentType ?? 'application/octet-stream',
      size: a.size ?? a.content.length,
      content: a.content,
    })),
  };
}
