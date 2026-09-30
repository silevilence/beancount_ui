import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import App from './App';

it('renders the journal and configuration errors', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({detail: '请配置账本'}) }));
  render(<App />);
  expect(screen.getByRole('heading', { name: '日用账本' })).toBeInTheDocument();
  expect(await screen.findByRole('alert')).toHaveTextContent('请配置账本');
});
