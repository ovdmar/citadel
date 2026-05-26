import { Button } from "../../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../../components/ui/dialog.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip.js";

export function OverlaysSection() {
  return (
    <div className="flex flex-wrap gap-3">
      <Dialog>
        <DialogTrigger asChild>
          <Button>Open dialog</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Sample dialog</DialogTitle>
            <DialogDescription>Backdrop-dismissable. Esc closes. Focus trapped inside the content.</DialogDescription>
          </DialogHeader>
          <p className="text-sm">Body content goes here.</p>
          <DialogFooter>
            <Button variant="secondary">Cancel</Button>
            <Button>Confirm</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="secondary">Hover for tooltip</Button>
        </TooltipTrigger>
        <TooltipContent>Cockpit defaults: 250ms / 100ms.</TooltipContent>
      </Tooltip>
    </div>
  );
}
