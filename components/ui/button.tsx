import * as React from 'react';
import { cn } from '@/lib/utils';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'secondary' | 'success' | 'danger' | 'outline' | 'ghost';
  size?: 'sm' | 'md' | 'lg' | 'xl';
  children: React.ReactNode;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', size = 'md', children, disabled, ...props }, ref) => {
    const baseStyles = 'inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-gray-900 disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none';

    const variants = {
      default: 'bg-gray-700 text-white hover:bg-gray-600 focus:ring-gray-500',
      primary: 'bg-blue-600 text-white hover:bg-blue-700 focus:ring-blue-500 shadow-lg shadow-blue-500/20',
      secondary: 'bg-purple-600 text-white hover:bg-purple-700 focus:ring-purple-500 shadow-lg shadow-purple-500/20',
      success: 'bg-green-600 text-white hover:bg-green-700 focus:ring-green-500 shadow-lg shadow-green-500/20',
      danger: 'bg-red-600 text-white hover:bg-red-700 focus:ring-red-500 shadow-lg shadow-red-500/20',
      outline: 'border-2 border-gray-600 text-gray-200 hover:bg-gray-800 hover:border-gray-500 focus:ring-gray-500',
      ghost: 'text-gray-300 hover:bg-gray-800 hover:text-white focus:ring-gray-500',
    };

    const sizes = {
      sm: 'px-3 py-2 text-sm',
      md: 'px-4 py-3 text-base',
      lg: 'px-6 py-4 text-lg',
      xl: 'px-8 py-5 text-xl',
    };

    return (
      <button
        ref={ref}
        className={cn(baseStyles, variants[variant], sizes[size], className)}
        disabled={disabled}
        {...props}
      >
        {children}
      </button>
    );
  }
);

Button.displayName = 'Button';

export { Button };
