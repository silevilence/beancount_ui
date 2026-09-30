import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import App from './App';

const status = {writable: true, version: '3.2.3', files: [], errors: [], git: {sync: '待提交'}, include_graph: {}, unreferenced: []};
it('filters by date and payee, distinguishes stale data and drafts', async () => {
  const fetcher = vi.fn().mockImplementation(async (url: string) => ({ok: true, json: async () => url === '/api/ledger' ? status : {
    date: new URL(`http://local${url}`).searchParams.get('day'), stale: true, transactions: [], expenses: {CNY: '25.50'}, income: {CNY: '100.12'}, accounts: [],
  }}));
  vi.stubGlobal('fetch', fetcher);
  render(<App />);
  expect(await screen.findByText('25.50 CNY')).toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('上一次有效视图');
  fireEvent.change(screen.getByLabelText('记账日期'), {target: {value: '2026-09-30'}});
  fireEvent.change(screen.getByPlaceholderText('筛选商户'), {target: {value: '食堂'}});
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => String(url).includes('day=2026-09-30&payee='))).toBe(true));
  fireEvent.change(screen.getByLabelText('待记便笺'), {target: {value: '待记 20 元'}});
  expect(screen.getByText('草稿 · 不计入收支')).toBeInTheDocument();
  fireEvent.click(screen.getByText('清除便笺'));
  expect(screen.getByLabelText('待记便笺')).toHaveValue('');
});

it('renders the journal and configuration errors', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({detail: '请配置账本'}) }));
  render(<App />);
  expect(screen.getByRole('heading', { name: '把日子，记清楚。' })).toBeInTheDocument();
  expect(await screen.findByRole('alert')).toHaveTextContent('请配置账本');
});
