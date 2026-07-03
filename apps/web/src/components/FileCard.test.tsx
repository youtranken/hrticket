import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { App as AntApp } from 'antd';
import '../i18n';
import { FileCard } from './FileCard';
import type { AttachmentMeta } from '../lib/files';
import * as filesLib from '../lib/files';

function renderCard(att: AttachmentMeta) {
  return render(
    <AntApp>
      <FileCard attachment={att} />
    </AntApp>,
  );
}

const base: AttachmentMeta = {
  id: 'a1',
  fileName: 'doc.pdf',
  mimeType: 'application/pdf',
  size: 1234,
  status: 'stored',
};

describe('FileCard (Story 8.2)', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
      matches: false,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    vi.restoreAllMocks();
  });

  it.each([
    ['image/png', '.anticon-file-image'],
    ['application/pdf', '.anticon-file-pdf'],
    ['audio/mpeg', '.anticon-sound'],
    ['video/mp4', '.anticon-video-camera'],
    ['application/octet-stream', '.anticon-paper-clip'],
  ])('renders the kind icon for %s', (mime, iconClass) => {
    const { container } = renderCard({ ...base, mimeType: mime });
    expect(container.querySelector(iconClass)).toBeTruthy();
  });

  it('shows the original filename and human size for a stored file', () => {
    renderCard({ ...base, fileName: 'payslip.pdf', size: 2 * 1024 * 1024 });
    expect(screen.getByText('payslip.pdf')).toBeTruthy();
    expect(screen.getByText('2.0 MB')).toBeTruthy();
  });

  it('LAZY: rendering a card makes NO access-url request (AC1)', () => {
    const spy = vi.spyOn(filesLib, 'mintAccessUrl');
    renderCard(base);
    expect(spy).not.toHaveBeenCalled();
  });

  it('blocked_unsafe → greyed warning glyph, not clickable, no mint on click', () => {
    const spy = vi.spyOn(filesLib, 'mintAccessUrl');
    const { container } = renderCard({ ...base, status: 'blocked_unsafe' });
    // The warning glyph is now an AntD icon, not a "⚠" text node.
    expect(container.querySelector('.anticon-warning')).toBeTruthy();
    // clicking a blocked card must not open the viewer / mint a URL
    fireEvent.click(screen.getByText('doc.pdf'));
    expect(spy).not.toHaveBeenCalled();
  });

  it('canPreviewInline honours the fixed thresholds', () => {
    expect(filesLib.canPreviewInline({ ...base, mimeType: 'image/png', size: 8 * 1024 * 1024 })).toBe(true);
    expect(filesLib.canPreviewInline({ ...base, mimeType: 'image/png', size: 15 * 1024 * 1024 })).toBe(false);
    expect(filesLib.canPreviewInline({ ...base, mimeType: 'application/pdf', size: 20 * 1024 * 1024 })).toBe(true);
    expect(filesLib.canPreviewInline({ ...base, mimeType: 'application/pdf', size: 30 * 1024 * 1024 })).toBe(false);
    // media streams regardless of size
    expect(filesLib.canPreviewInline({ ...base, mimeType: 'audio/mpeg', size: 99 * 1024 * 1024 })).toBe(true);
    expect(filesLib.canPreviewInline({ ...base, mimeType: 'video/mp4', size: 99 * 1024 * 1024 })).toBe(true);
    // unknown codec never previews
    expect(filesLib.canPreviewInline({ ...base, mimeType: 'application/zip', size: 1 })).toBe(false);
  });
});
