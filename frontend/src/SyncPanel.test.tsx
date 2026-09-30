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

it('展示提交范围并确认同步，失败不提示重新保存', async () => {
  const fetcher = vi.fn(async (url: string) => ({ok: true, json: async () => url.endsWith('/backup-preview') ? {
    revision: 'r', head: 'h', files: ['09.bean'], excluded: ['secret.log'], message: '账本备份', diff: '+saved',
  } : {connected: true, enabled: false, branch: 'master-1', changes: [], sync: '已同步'}}));
  vi.stubGlobal('fetch', fetcher);
  const changed = vi.fn(async () => {});
  render(<SyncPanel onChanged={changed} />);
  fireEvent.click(await screen.findByText('立即同步'));
  expect(await screen.findByText('排除：secret.log')).toBeInTheDocument();
  fireEvent.click(screen.getByText('确认校验并推送'));
  await waitFor(() => expect(changed).toHaveBeenCalled());
  expect(fetcher.mock.calls.some(c => c[0] === '/api/sync/backup')).toBe(true);
});

it('调整间隔并启停定时备份', async () => {
  let enabled = false;
  const fetcher = vi.fn(async (_url: string, options?: RequestInit) => {
    if (options?.body) enabled = JSON.parse(String(options.body)).enabled;
    return {ok: true, json: async () => ({connected: true, enabled, branch: 'master-1', changes: [], interval: 25, quiet: 10})};
  });
  vi.stubGlobal('fetch', fetcher);
  render(<SyncPanel onChanged={async () => {}} />);
  fireEvent.change(await screen.findByLabelText('检查间隔（秒）'), {target: {value: '25'}});
  fireEvent.change(screen.getByLabelText('保存后等待（秒）'), {target: {value: '10'}});
  fireEvent.click(screen.getByText('启用 / 更新定时备份'));
  expect(await screen.findByText('定时备份 · 已开启')).toBeInTheDocument();
  fireEvent.click(screen.getByText('关闭定时备份'));
  expect(await screen.findByText('定时备份 · 已关闭')).toBeInTheDocument();
});
