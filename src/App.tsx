import * as React from "react";

import { Header } from "@/components/header";
import { InfoDialog } from "@/components/info-dialog";
import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UploadZone } from "@/components/upload-zone";

export default function App() {
  const [infoOpen, setInfoOpen] = React.useState(false);

  return (
    <ThemeProvider>
      <TooltipProvider delayDuration={150} skipDelayDuration={50}>
        <div className="flex h-screen flex-col bg-background text-foreground">
          <Header onInfoClick={() => setInfoOpen(true)} />
          <main className="flex min-h-0 flex-1 flex-col overflow-hidden pt-10">
            <UploadZone />
          </main>
          <InfoDialog open={infoOpen} onClose={() => setInfoOpen(false)} />
        </div>
      </TooltipProvider>
    </ThemeProvider>
  );
}
