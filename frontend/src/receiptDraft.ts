import type { ManagedOrder } from "./OrderPage";
import type { Named, Product } from "./Inventory";

export interface ReceiptOptions {
  instance_id: string;
  products: Product[];
  locations: Named[];
  default_location_id: number | null;
  default_best_before_days: number | null;
}
export interface ReceiptDraft {
  order: ManagedOrder;
  manualExpiry?: string[];
  manualLocation?: string[];
  body: {
    request_id: string;
    order_id: string;
    received_date: string;
    lines: {
      item_id: string;
      quantity: string;
      location_id: number | null;
      best_before_date: string | null;
      unit_price: string | null;
    }[];
    settlement: { date: string; amount: string; account: string } | null;
  };
}

export function expiryDate(day: string, days?: number | null): string {
  if (days == null || !day) return "";
  if (Number(days) === -1) return "2999-12-31";
  const date = new Date(`${day}T00:00:00Z`);
  if (!Number.isFinite(date.getTime())) return "";
  date.setUTCDate(date.getUTCDate() + Number(days));
  return date.toISOString().slice(0, 10);
}
