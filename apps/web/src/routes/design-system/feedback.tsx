import { Button } from "../../components/ui/button.js";
import { toast } from "../../components/ui/toast.js";

export function FeedbackSection() {
  return (
    <div className="flex flex-wrap gap-2">
      <Button onClick={() => toast({ title: "Default toast", description: "Nothing fancy." })}>Default</Button>
      <Button
        variant="secondary"
        onClick={() => toast({ title: "Saved", description: "Your changes are live.", variant: "success" })}
      >
        Success
      </Button>
      <Button
        variant="secondary"
        onClick={() => toast({ title: "Heads up", description: "Provider degraded.", variant: "warning" })}
      >
        Warning
      </Button>
      <Button
        variant="destructive"
        onClick={() => toast({ title: "Hook failed", description: "See operations panel.", variant: "danger" })}
      >
        Danger
      </Button>
    </div>
  );
}
