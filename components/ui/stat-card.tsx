import * as React from 'react';
import { cn } from '@/lib/utils';

export interface StatCardProps extends React.HTMLAttributes<HTMLDivElement> {
  label: string;
  value: string | number;
  icon?: React.ReactNode;
  trend?: 'up' | 'down' | 'neutral';
  trendValue?: string;
  variant?: 'default' | 'primary' | 'success' | 'warning' | 'danger';
}

const StatCard = React.forwardRef<HTMLDivElement, StatCardProps>(
  ({ className, label, value, icon, trend, trendValue, variant = 'default', ...props }, ref) => {
    const variants = {
      default: 'bg-gray-800 border-gray-700',
      primary: 'bg-blue-900/20 border-blue-700/50',
      success: 'bg-green-900/20 border-green-700/50',
      warning: 'bg-yellow-900/20 border-yellow-700/50',
      danger: 'bg-red-900/20 border-red-700/50',
    };

    const iconColors = {
      default: 'text-gray-400',
      primary: 'text-blue-400',
      success: 'text-green-400',
      warning: 'text-yellow-400',
      danger: 'text-red-400',
    };

    return (
      <div
        ref={ref}
        className={cn(
          'rounded-xl p-6 border transition-all duration-200 hover:shadow-lg',
          variants[variant],
          className
        )}
        {...props}
      >
        <div className="flex items-start justify-between">
          <div className="flex-1">
            <p className="text-sm font-medium text-gray-400 uppercase tracking-wider">{label}</p>
            <p className="mt-2 text-3xl font-bold text-white">{value}</p>
            {trendValue && (
              <div className="mt-2 flex items-center gap-1 text-sm">
                {trend === 'up' && <span className="text-green-400">↑</span>}
                {trend === 'down' && <span className="text-red-400">↓</span>}
                <span className={cn(
                  trend === 'up' && 'text-green-400',
                  trend === 'down' && 'text-red-400',
                  trend === 'neutral' && 'text-gray-400'
                )}>
                  {trendValue}
                </span>
              </div>
            )}
          </div>
          {icon && (
            <div className={cn('text-3xl', iconColors[variant])}>
              {icon}
            </div>
          )}
        </div>
      </div>
    );
  }
);

StatCard.displayName = 'StatCard';

export { StatCard };
