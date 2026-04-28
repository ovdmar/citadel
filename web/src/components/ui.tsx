import type { ReactNode, ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';

function cn(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(' ');
}

export function AppCard({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('ui-card', className)} {...props}>{children}</div>;
}

export function Surface({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('ui-surface', className)} {...props}>{children}</div>;
}

export function IconButton({ className, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={cn('ui-icon-button', className)} {...props}>{children}</button>;
}

export function Button({ className, variant = 'default', size = 'default', children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'secondary' | 'ghost' | 'danger'; size?: 'default' | 'sm' | 'icon'; }) {
  return <button className={cn('ui-button', `ui-button-${variant}`, `ui-button-${size}`, className)} {...props}>{children}</button>;
}

export function Field({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn('ui-field', className)} {...props} />;
}

export function TextInput({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn('ui-text-input', className)} {...props} />;
}

export function TextArea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn('ui-text-area', className)} {...props} />;
}

export function KpiPill({ value, label, tone = 'neutral' }: { value: ReactNode; label: string; tone?: 'neutral' | 'accent' | 'ok' | 'warn' | 'danger' }) {
  return (
    <div className={cn('kpi-pill', `kpi-pill-${tone}`)}>
      <div className="kpi-value">{value}</div>
      <div className="kpi-label">{label}</div>
    </div>
  );
}

export function MetaRow({ label, value, mono = false }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="meta-row">
      <span className="meta-label">{label}</span>
      <span className={cn('meta-value', mono && 'mono')}>{value}</span>
    </div>
  );
}
