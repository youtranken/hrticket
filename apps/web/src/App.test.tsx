import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';

describe('App shell (Story 1.1)', () => {
  it('renders the bootstrap card title', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ pong: true }) }));
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <App />
      </QueryClientProvider>,
    );
    expect(screen.getByText(/HRIS \/ C&B Ticket Management/i)).toBeTruthy();
  });
});
