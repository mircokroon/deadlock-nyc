import { Github, Info, Moon, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useTheme } from "@/components/theme-provider";

const GITHUB_URL = "https://github.com/pnxenopoulos/boon";
const X_URL = "https://x.com/peterxeno";

// The X (formerly Twitter) brand mark. Lucide's `X` is the close/cross glyph,
// not the logo, so we inline the brand path. `fill="currentColor"` lets it
// inherit the header text color like the other icons; the Button sizes it.
function XIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

export function Header({ onInfoClick }: { onInfoClick: () => void }) {
  const { theme, toggle } = useTheme();
  return (
    <header className="fixed inset-x-0 top-0 z-50 border-b border-border bg-sidebar text-sidebar-foreground">
      <div className="mx-auto flex h-10 max-w-6xl items-center justify-between px-4">
        <a
          href="/"
          className="text-sm font-medium tracking-tight text-sidebar-foreground hover:opacity-90"
        >
          deadlock.nyc
        </a>

        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            onClick={toggle}
            aria-label="Toggle theme"
            className="size-8 text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            {theme === "dark" ? <Sun /> : <Moon />}
          </Button>

          <Button
            variant="ghost"
            size="icon"
            asChild
            aria-label="GitHub"
            className="size-8 text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            <a href={GITHUB_URL} target="_blank" rel="noreferrer">
              <Github />
            </a>
          </Button>

          <Button
            variant="ghost"
            size="icon"
            asChild
            aria-label="X (Twitter)"
            className="size-8 text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            <a href={X_URL} target="_blank" rel="noreferrer">
              <XIcon />
            </a>
          </Button>

          <Button
            variant="ghost"
            size="icon"
            onClick={onInfoClick}
            aria-label="About"
            className="size-8 text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            <Info />
          </Button>
        </div>
      </div>
    </header>
  );
}
