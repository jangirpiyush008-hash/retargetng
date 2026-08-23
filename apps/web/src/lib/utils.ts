import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
export function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)); }

const nf = new Intl.NumberFormat('en-IN');
export function fmtNum(n: number | null | undefined): string { if (n == null || Number.isNaN(Number(n))) return '—'; return nf.format(Math.round(Number(n))); }
export function fmtCompact(n: number | null | undefined): string { if (n == null) return '—'; const v = Number(n); if (Math.abs(v) >= 1e7) return (v / 1e7).toFixed(2) + ' Cr'; if (Math.abs(v) >= 1e5) return (v / 1e5).toFixed(2) + ' L'; if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1) + 'k'; return nf.format(Math.round(v)); }
export function fmtMoney(n: number | null | undefined, currency = 'INR'): string { if (n == null) return '—'; return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(Number(n)); }
export function fmtPct(n: number | null | undefined, digits = 1): string { if (n == null) return '—'; return Number(n).toFixed(digits) + '%'; }
export function fmtDate(d: string | Date | null | undefined): string { if (!d) return '—'; return new Date(d).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }); }
export function fmtDay(d: string | Date | null | undefined): string { if (!d) return '—'; return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }); }
export function timeAgo(d: string | Date | null | undefined): string {
  if (!d) return 'never';
  const diffMs = Date.now() - new Date(d).getTime();
  const future = diffMs < 0;
  const s = Math.round(Math.abs(diffMs) / 1000);
  const span = s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)} min` : s < 48 * 3600 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
  return future ? `in ${span}` : `${span} ago`;
}
export function titleCase(s: string | null | undefined): string { return (s ?? '').toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()); }
