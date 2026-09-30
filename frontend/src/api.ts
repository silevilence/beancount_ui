export interface Diagnostic {
  file: string;
  line: number;
  message: string;
}
export interface Transaction {
  id: string;
  date: string;
  payee: string;
  narration: string;
  kind: string;
  tags: string[];
  postings: { account: string; amount: string; currency: string }[];
  file: string;
  line: number;
  raw: string;
  simple: boolean;
  readonly: boolean;
  note: string;
}
export interface Journal {
  identity?: string;
  date: string;
  revision: string;
  view_revision: string;
  stale: boolean;
  errors: Diagnostic[];
  transactions: Transaction[];
  expenses: Record<string, string>;
  income: Record<string, string>;
  accounts: { name: string; currencies: string[] }[];
  sync: string;
}
export interface LedgerStatus {
  entry: string;
  version: string;
  revision: string;
  writable: boolean;
  errors: Diagnostic[];
  files: string[];
  include_graph: Record<string, string[]>;
  unreferenced: string[];
  entry_count: number;
  accounts: string[];
  git: {
    repository: boolean;
    branch?: string;
    commit?: string;
    changes?: string[];
    sync: string;
  };
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, options);
  const data = await response.json();
  if (!response.ok)
    throw new ApiError(
      typeof data.detail === "string"
        ? data.detail
        : JSON.stringify(data.detail),
      response.status,
    );
  return data as T;
}
