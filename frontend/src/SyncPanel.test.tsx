import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import SyncPanel from './SyncPanel';

it('预览既有变更、明确接入并保持自动备份关闭', async () => {
  const changed = vi.fn(async () => {});
  const fetcher = vi.fn(async (url: string) => ({ok: true, json: async () => url.endsWith('/preview') ? {
    revision: 'r', remote: 'test.git', branch: 'master-1', changes: [{status: ' M', file: '09.bean'}],
    unreferenced: [], errors: [], diff: '',
  } : {connected: true, enabled: false, branch: 'master-1', changes: []}}));
  vi.stubGlobal('fetch', fetcher);
  render(<SyncPanel onChanged={changed} />);
  fireEvent.click(screen.getByText('预览接入范围'));
  expect(await screen.findByText('M 09.bean')).toBeInTheDocument();
  fireEvent.click(screen.getByText('确认接入（保持自动备份关闭）'));
  await waitFor(() => expect(changed).toHaveBeenCalled());
  expect(screen.getByText('自动备份关闭')).toBeInTheDocument();
});

it('备份失败提醒本地记录保留', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ok: false, status: 409, json: async () => ({detail: '网络不可用'})})));
  render(<SyncPanel onChanged={async () => {}} />);
  fireEvent.click(screen.getByText('克隆到空目录'));
  expect(await screen.findByRole('alert')).toHaveTextContent('已保存的记录仍在本地');
});
