'use client';
import * as React from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { cn } from '@/lib/utils';

export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;
export const TooltipContent = React.forwardRef<React.ElementRef<typeof TooltipPrimitive.Content>, React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>>(({ className, sideOffset = 4, ...props }, ref) => (
  <TooltipPrimitive.Portal><TooltipPrimitive.Content ref={ref} sideOffset={sideOffset} className={cn('z-50 max-w-xs overflow-hidden rounded-md bg-foreground px-3 py-1.5 text-xs text-background shadow-md animate-in fade-in-0 zoom-in-95', className)} {...props} /></TooltipPrimitive.Portal>
));
TooltipContent.displayName = 'TooltipContent';

export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) { return <div className={cn('animate-pulse rounded-md bg-muted', className)} {...props} />; }
export function Separator({ className, orientation = 'horizontal' }: { className?: string; orientation?: 'horizontal' | 'vertical' }) { return <div className={cn('shrink-0 bg-border', orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px', className)} />; }
export function Progress({ value, className, indicatorClassName }: { value: number; className?: string; indicatorClassName?: string }) {
  return <div className={cn('relative h-2 w-full overflow-hidden rounded-full bg-muted', className)}><div className={cn('h-full rounded-full bg-primary transition-all', indicatorClassName)} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></div>;
}
export function Textarea({ className, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn('flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50', className)} {...props} />;
}
export function Kbd({ children }: { children: React.ReactNode }) { return <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{children}</kbd>; }
export function EmptyState({ icon: Icon, title, description, action }: { icon?: React.ComponentType<{ className?: string }>; title: string; description?: string; action?: React.ReactNode }) {
  return (<div className="flex flex-col items-center justify-center rounded-xl border border-dashed px-6 py-12 text-center">
    {Icon && <div className="mb-3 rounded-full bg-muted p-3"><Icon className="h-5 w-5 text-muted-foreground" /></div>}
    <div className="text-sm font-medium">{title}</div>{description && <div className="mt-1 max-w-sm text-xs text-muted-foreground">{description}</div>}{action && <div className="mt-4">{action}</div>}
  </div>);
}
