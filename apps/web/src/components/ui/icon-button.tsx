import * as React from "react";
import { Button, type ButtonProps } from "./button.js";

// IconButton: a Button preset to size="icon" that REQUIRES an aria-label at
// the type level. Excludes `asChild` to keep the aria-label guarantee — a
// polymorphic icon-link should use Button directly and supply its own
// aria-label.
export type IconButtonProps = Omit<ButtonProps, "asChild" | "children" | "size"> & {
  "aria-label": string;
  children: React.ReactNode;
};

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ "aria-label": ariaLabel, children, ...props }, ref) => {
    if (!ariaLabel) {
      console.warn(
        "IconButton: aria-label is empty. Icon-only controls need a non-empty label so screen readers announce them.",
      );
    }
    return (
      <Button ref={ref} size="icon" aria-label={ariaLabel} title={ariaLabel} {...props}>
        {children}
      </Button>
    );
  },
);
IconButton.displayName = "IconButton";
