import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs.js";

export function NavigationSection() {
  const [tab, setTab] = useState("stats");
  return (
    <Tabs value={tab} onValueChange={setTab}>
      <TabsList data-active={tab}>
        <TabsTrigger value="stats">Stats</TabsTrigger>
        <TabsTrigger value="diff">Diff</TabsTrigger>
        <TabsTrigger value="apps">Apps</TabsTrigger>
      </TabsList>
      <TabsContent value="stats" className="pt-3 text-sm text-[var(--c-fg-2)]">
        Stats tab content. Compact pill-style trigger row, parent-level data-active for legacy CSS hooks.
      </TabsContent>
      <TabsContent value="diff" className="pt-3 text-sm text-[var(--c-fg-2)]">
        Diff tab content.
      </TabsContent>
      <TabsContent value="apps" className="pt-3 text-sm text-[var(--c-fg-2)]">
        Apps tab content.
      </TabsContent>
    </Tabs>
  );
}
