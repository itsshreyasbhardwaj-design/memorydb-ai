/**
 * UI primitives.
 *
 * Small, unopinionated building blocks styled from the design tokens in
 * `globals.css`. Everything is a plain forwarded-ref component so it composes
 * with Radix and native DOM props without wrappers.
 */
import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from '@radix-ui/react-slot';
import { cn } from '@/lib/utils';

/* ------------------------------- Button ---------------------------------- */

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius-control)] text-sm font-medium transition-all duration-150 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 active:scale-[0.98]',
  {
    variants: {
      variant: {
        primary:
          'bg-[var(--color-accent)] text-[var(--color-canvas)] font-semibold hover:brightness-110 shadow-[0_1px_2px_oklch(0_0_0/0.3)]',
        secondary:
          'bg-[var(--color-surface-raised)] text-[var(--color-fg)] border border-[var(--color-border)] hover:bg-[var(--color-surface-overlay)] hover:border-[var(--color-border-strong)]',
        ghost: 'text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-fg)]',
        danger: 'bg-[var(--color-danger)] text-white hover:brightness-110',
        outline:
          'border border-[var(--color-border-strong)] text-[var(--color-fg)] hover:bg-[var(--color-surface-raised)]',
      },
      size: {
        sm: 'h-8 px-3 text-xs',
        md: 'h-9 px-4',
        lg: 'h-11 px-6 text-base',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Component = asChild ? Slot : 'button';
    return <Component ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
  },
);
Button.displayName = 'Button';

/* -------------------------------- Card ----------------------------------- */

export const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('glass rounded-[var(--radius-card)]', className)} {...props} />
  ),
);
Card.displayName = 'Card';

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-1 p-5 pb-3', className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn('text-sm font-semibold tracking-tight', className)} {...props} />;
}

export function CardDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('text-xs text-[var(--color-fg-subtle)]', className)} {...props} />;
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-5 pt-0', className)} {...props} />;
}

/* -------------------------------- Badge ---------------------------------- */

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium leading-5 transition-colors',
  {
    variants: {
      variant: {
        default: 'bg-[var(--color-surface-overlay)] text-[var(--color-fg-muted)] border border-[var(--color-border)]',
        accent: 'bg-[color-mix(in_oklch,var(--color-accent)_15%,transparent)] text-[var(--color-accent)] border border-[color-mix(in_oklch,var(--color-accent)_30%,transparent)]',
        success: 'bg-[color-mix(in_oklch,var(--color-success)_15%,transparent)] text-[var(--color-success)] border border-[color-mix(in_oklch,var(--color-success)_30%,transparent)]',
        warning: 'bg-[color-mix(in_oklch,var(--color-warning)_15%,transparent)] text-[var(--color-warning)] border border-[color-mix(in_oklch,var(--color-warning)_30%,transparent)]',
        danger: 'bg-[color-mix(in_oklch,var(--color-danger)_15%,transparent)] text-[var(--color-danger)] border border-[color-mix(in_oklch,var(--color-danger)_30%,transparent)]',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

/** Badge tinted by memory type, using the shared per-type hue. */
export function TypeBadge({ type, className }: { type: string; className?: string }) {
  const color = `var(--color-type-${type.replace(/_/g, '-')})`;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium leading-5',
        className,
      )}
      style={{
        color,
        backgroundColor: `color-mix(in oklch, ${color} 14%, transparent)`,
        borderColor: `color-mix(in oklch, ${color} 28%, transparent)`,
      }}
    >
      <span className="size-1.5 rounded-full" style={{ backgroundColor: color }} aria-hidden />
      {type.replace(/_/g, ' ')}
    </span>
  );
}

/* -------------------------------- Input ---------------------------------- */

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'flex h-9 w-full rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-1 text-sm',
        'placeholder:text-[var(--color-fg-subtle)] transition-colors',
        'focus:border-[var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      'flex min-h-20 w-full rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2 text-sm',
      'placeholder:text-[var(--color-fg-subtle)] transition-colors resize-y',
      'focus:border-[var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]',
      className,
    )}
    {...props}
  />
));
Textarea.displayName = 'Textarea';

/* ------------------------------- Skeleton -------------------------------- */

export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('shimmer rounded-md', className)} {...props} />;
}

/* ------------------------------ Empty state ------------------------------ */

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      {icon && <div className="text-[var(--color-fg-subtle)] [&_svg]:size-8">{icon}</div>}
      <div className="space-y-1">
        <p className="text-sm font-medium text-[var(--color-fg)]">{title}</p>
        {description && (
          <p className="mx-auto max-w-sm text-xs text-[var(--color-fg-subtle)]">{description}</p>
        )}
      </div>
      {action}
    </div>
  );
}

/* -------------------------------- Spinner -------------------------------- */

export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={cn('animate-spin', className)}
      viewBox="0 0 24 24"
      fill="none"
      role="status"
      aria-label="Loading"
    >
      <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path
        className="opacity-90"
        d="M12 2a10 10 0 0 1 10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

/* ------------------------------- Progress -------------------------------- */

export function Progress({ value, className, color }: { value: number; className?: string; color?: string }) {
  const clamped = Math.max(0, Math.min(1, value));
  return (
    <div
      className={cn('h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-surface-overlay)]', className)}
      role="progressbar"
      aria-valuenow={Math.round(clamped * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className="h-full rounded-full transition-[width] duration-500 [transition-timing-function:var(--ease-out-expo)]"
        style={{ width: `${clamped * 100}%`, backgroundColor: color ?? 'var(--color-accent)' }}
      />
    </div>
  );
}
