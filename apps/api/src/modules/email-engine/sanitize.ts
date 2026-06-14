import sanitizeHtml from 'sanitize-html';
import type { CidMap } from '../intake/attachments';

/**
 * Server-side email sanitisation (A.6 / Story 3.7) — the PRIMARY XSS defence,
 * applied at INGEST; the raw body is kept untouched for audit (FR19). Strips
 * `<script>/<style>`, event handlers and `javascript:` URLs; rewrites inline
 * `cid:` images to a stable `/api/files/{id}` placeholder (the reader signs it
 * fresh, since a 15-min token would be stale by view time); and DEFANGS remote
 * images into `data-remote-src` so they don't auto-load (tracking pixels, AC4) —
 * the FE re-arms them on "show remote images".
 */
export function sanitizeEmailHtml(rawHtml: string | null | undefined, cidMap: CidMap = {}): string {
  if (!rawHtml) return '';
  return sanitizeHtml(rawHtml, {
    allowedTags: [
      ...sanitizeHtml.defaults.allowedTags,
      'img',
      'span',
      'font',
      'center',
      'u',
      's',
    ],
    allowedAttributes: {
      '*': ['style', 'class', 'align', 'dir', 'width', 'height', 'bgcolor', 'color'],
      a: ['href', 'name', 'target', 'rel'],
      img: ['src', 'alt', 'title', 'width', 'height', 'data-remote-src'],
      td: ['colspan', 'rowspan', 'valign'],
      th: ['colspan', 'rowspan', 'valign'],
    },
    // No `javascript:`; cid handled in transform before scheme check.
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['http', 'https'] },
    allowedSchemesAppliedToAttributes: ['href', 'src'],
    // Whitelist inline CSS to typography/colour only — NONE of these take url(), so a
    // `background:url(javascript:…)` payload is stripped wholesale (FR12 layer).
    allowedStyles: {
      '*': {
        color: [/^[#a-z0-9(),.%\- ]+$/i],
        'background-color': [/^[#a-z0-9(),.%\- ]+$/i],
        'text-align': [/^(left|right|center|justify)$/i],
        'text-decoration': [/^[a-z\- ]+$/i],
        'font-weight': [/^(normal|bold|bolder|lighter|\d{1,3})$/i],
        'font-style': [/^(normal|italic|oblique)$/i],
        'font-size': [/^\d+(\.\d+)?(px|em|rem|%|pt)$/i],
        'font-family': [/^[a-z0-9 ,'"-]+$/i],
        margin: [/^[0-9a-z.%\- ]+$/i],
        padding: [/^[0-9a-z.%\- ]+$/i],
      },
    },
    transformTags: {
      a: (tagName, attribs) => ({
        tagName,
        attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer nofollow' },
      }),
      img: (tagName, attribs) => {
        const src = (attribs.src ?? '').trim();
        const rest = { ...attribs };
        delete rest.src;
        if (/^cid:/i.test(src)) {
          const cid = src.slice(4).replace(/^<|>$/g, '');
          const id = cidMap[cid];
          // Known inline image → stable placeholder; reader signs it. Unknown → drop.
          return id
            ? { tagName, attribs: { ...rest, src: `/api/files/${id}` } }
            : { tagName, attribs: rest };
        }
        if (/^https?:/i.test(src)) {
          // Remote image → blocked by default; stash for the "show remote images" toggle.
          return { tagName, attribs: { ...rest, 'data-remote-src': src } };
        }
        // data:, file:, anything else → drop the src entirely.
        return { tagName, attribs: rest };
      },
    },
  });
}
