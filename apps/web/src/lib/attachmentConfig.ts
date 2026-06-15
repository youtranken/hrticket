import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './apiClient';

export interface DiskUsage {
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  usedPct: number;
  freePct: number;
}

export interface AttachmentConfig {
  allowedExtensions: string[];
  capMb: number;
  autotag: { attachment: boolean; crosspost: boolean; autoreply: boolean };
  diskAlertPct: number;
  signatureWarning: string[];
  disk: DiskUsage;
}

export type AttachmentConfigPatch = Partial<{
  allowedExtensions: string[];
  capMb: number;
  autotag: Partial<AttachmentConfig['autotag']>;
  diskAlertPct: number;
}>;

export function useAttachmentConfig() {
  return useQuery<AttachmentConfig>({
    queryKey: ['attachment-config'],
    queryFn: () => api('/admin/attachment-config'),
  });
}

export function useSaveAttachmentConfig() {
  const qc = useQueryClient();
  return useMutation<AttachmentConfig, Error, AttachmentConfigPatch>({
    mutationFn: (patch) => api('/admin/attachment-config', { method: 'PUT', body: JSON.stringify(patch) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['attachment-config'] }),
  });
}
