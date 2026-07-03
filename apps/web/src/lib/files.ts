import { useQuery } from '@tanstack/react-query';
import { api } from './apiClient';

/** Upload gate the admin edits in /admin/attachments — FE pickers must read it from
 *  here, never hardcode a copy (the server re-enforces on every store). */
export interface UploadPolicy {
  allowedExtensions: string[];
  capMb: number;
}

export function useUploadPolicy() {
  return useQuery<UploadPolicy>({
    queryKey: ['upload-policy'],
    queryFn: () => api('/upload-policy'),
    staleTime: 5 * 60_000,
  });
}

/**
 * Fixed preview thresholds (NFR1 exception, Story 8.2). These are a pure FRONT-END
 * preview decision — the backend does NOT enforce them — so they live here, not in
 * packages/shared. Above the threshold we fall back to download / open-in-new-tab
 * instead of rendering inline, keeping a heavy ticket fast to open.
 *   image preview ≤ 10MB · pdf preview ≤ 25MB (NOT configurable).
 */
export const IMAGE_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;
export const PDF_PREVIEW_MAX_BYTES = 25 * 1024 * 1024;

export interface AttachmentMeta {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  status: string; // 'stored' | 'blocked_unsafe' | 'pending' | ...
}

export type FileKind = 'image' | 'pdf' | 'audio' | 'video' | 'other';

/** Classify by sniffed MIME (the BE stored the real type, not the declared one). */
export function fileKind(mimeType: string): FileKind {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  return 'other';
}

/** True iff this attachment can be previewed inline (kind + size threshold). */
export function canPreviewInline(att: AttachmentMeta): boolean {
  switch (fileKind(att.mimeType)) {
    case 'audio':
    case 'video':
      return true; // streamed via Range — size-independent
    case 'image':
      return att.size <= IMAGE_PREVIEW_MAX_BYTES;
    case 'pdf':
      return att.size <= PDF_PREVIEW_MAX_BYTES;
    default:
      return false;
  }
}

/**
 * Mint a short-lived signed URL for one attachment (8.1 POST access-url). Called
 * ONLY on an explicit user action (open/expand) — never on ticket render — so a
 * ticket with N files makes ZERO /api/files requests until something is clicked
 * (lazy AC1). The minted URL is a same-origin relative path, used with cookies.
 */
export function mintAccessUrl(id: string): Promise<{ url: string }> {
  return api(`/files/${id}/access-url`, { method: 'POST' });
}

/** The same signed URL but flagged for download (?dl=1 → Content-Disposition
 *  attachment with the original Vietnamese filename). Always available as the
 *  universal fallback, even for codecs the browser cannot play. */
export function asDownloadUrl(url: string): string {
  return url + (url.includes('?') ? '&' : '?') + 'dl=1';
}

/** Human-readable byte size (shared by FileCard + viewer). */
export function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
