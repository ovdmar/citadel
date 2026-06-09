import { useState } from "react";
import { FormField } from "../../components/ui/form-field.js";
import { Input, Textarea } from "../../components/ui/input.js";
import { Select } from "../../components/ui/select.js";

export function FormsSection() {
  const [value, setValue] = useState("");
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <FormField label="Name" help="Used for greeting" required>
        <Input placeholder="Ada Lovelace" value={value} onChange={(e) => setValue(e.target.value)} />
      </FormField>
      <FormField label="Email" error={value === "" ? undefined : "Looks malformed"}>
        <Input type="email" defaultValue="not-an-email" />
      </FormField>
      <FormField label="Runtime">
        <Select defaultValue="claude">
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
          <option value="custom">Custom</option>
        </Select>
      </FormField>
      <FormField label="Notes">
        <Textarea rows={4} placeholder="Add context for the agent…" />
      </FormField>
      <FormField label="Disabled">
        <Input disabled defaultValue="Read-only" />
      </FormField>
    </div>
  );
}
