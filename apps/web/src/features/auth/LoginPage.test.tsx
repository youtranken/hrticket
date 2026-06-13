import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import '../../i18n';
import { LoginPage } from './LoginPage';

function renderLogin() {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <AntApp>
        <MemoryRouter>
          <LoginPage />
        </MemoryRouter>
      </AntApp>
    </QueryClientProvider>,
  );
}

describe('LoginPage (Story 1.4)', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  });

  it('renders email + password fields and a submit button', () => {
    renderLogin();
    expect(screen.getByText('VI')).toBeTruthy();
    expect(screen.getAllByRole('button').length).toBeGreaterThan(0);
  });
});
