import * as React from "react";
import { cn } from "../../lib/utils.js";
import { Label } from "./label.js";

// FormField composes a label + the rendered control + help/error text and
// wires the id, htmlFor, aria-describedby, aria-invalid, and required
// attributes consistently across the cockpit's forms. Pass the control as
// the single child. The field clones the child via React.cloneElement to
// inject the id and aria attrs without forcing the caller to repeat them.

export interface FormFieldProps {
  /** Label text shown above the control. */
  label: string;
  /**
   * Explicit id for the control. When omitted, a stable id is derived
   * with React.useId so the label still associates correctly.
   */
  id?: string;
  /** Help text rendered below the control. Mutually displayed with `error`. */
  help?: React.ReactNode;
  /** Error message rendered below the control. Sets aria-invalid on the control. */
  error?: React.ReactNode;
  /** Marks the control as required (visual marker + required attribute on the control). */
  required?: boolean;
  /** Additional class names for the field wrapper. */
  className?: string;
  /** The single form control: Input, Textarea, Select, or compatible. */
  children: React.ReactElement;
}

type ControlInjectedProps = {
  id: string;
  required?: boolean;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
};

export function FormField({ label, id, help, error, required, className, children }: FormFieldProps) {
  const generatedId = React.useId();
  const fieldId = id ?? generatedId;
  const helpId = `${fieldId}-help`;
  const errorId = `${fieldId}-error`;

  const describedBy = error ? errorId : help ? helpId : undefined;

  const injectedProps: ControlInjectedProps = {
    id: fieldId,
    ...(required ? { required: true } : {}),
    ...(describedBy ? { "aria-describedby": describedBy } : {}),
    ...(error ? { "aria-invalid": true } : {}),
  };
  const control = React.cloneElement(children, injectedProps);

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <Label htmlFor={fieldId}>
        {label}
        {required ? (
          <span data-slot="form-required" aria-hidden="true" className="ml-0.5 text-[var(--color-danger)]">
            *
          </span>
        ) : null}
      </Label>
      {control}
      {error ? (
        <p id={errorId} data-slot="form-error" role="alert" className="text-[11px] text-[var(--color-danger)]">
          {error}
        </p>
      ) : help ? (
        <p id={helpId} data-slot="form-help" className="text-[11px] text-[var(--c-fg-3)]">
          {help}
        </p>
      ) : null}
    </div>
  );
}
