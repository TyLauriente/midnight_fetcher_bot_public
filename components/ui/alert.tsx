import * as React from 'react';
import { cn } from '@/lib/utils';

export interface AlertProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: 'info' | 'success' | 'warning' | 'error';
  title?: string;
  children: React.ReactNode;
}

const Alert = React.forwardRef<HTMLDivElement, AlertProps>(
  ({ className, variant = 'info', title, children, ...props }, ref) => {
    const variants = {
      info: 'bg-blue-900/20 border-blue-500/50 text-blue-200',
      success: 'bg-green-900/20 border-green-500/50 text-green-200',
      warning: 'bg-yellow-900/20 border-yellow-500/50 text-yellow-200',
      error: 'bg-red-900/20 border-red-500/50 text-red-200',
    };

    const icons = {
      info: 'ℹ️',
      success: '✅',
      warning: '⚠️',
      error: '❌',
    };

    return (
      <div
        ref={ref}
        className={cn(
          'rounded-lg border p-4 flex gap-3 animate-in fade-in slide-in-from-top-2 duration-300',
          variants[variant],
          className
        )}
        {...props}
      >
        <div className="text-xl shrink-0">{icons[variant]}</div>
        <div className="flex-1 space-y-1">
          {title && <h4 className="font-semibold">{title}</h4>}
          <div className="text-sm leading-relaxed">{children}</div>
        </div>
      </div>
    );
  }
);

Alert.displayName = 'Alert';

export { Alert };
