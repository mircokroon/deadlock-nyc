import * as React from "react";
import { Settings } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useDialogEscape } from "@/lib/use-dialog-escape";
import { cn } from "@/lib/utils";

const TICKS_PER_SECOND = 64;

// Playback rate multipliers applied to the inter-frame delay.
const SPEED_OPTIONS = [0.5, 1, 2, 4, 8];
// Skip amounts for the back/forward buttons, in seconds (stored as ticks).
const STEP_OPTIONS = [5, 10, 30, 60];

/**
 * Gear button with a small upward popover for tuning playback: the play rate
 * and the back/forward skip amount. Closes on outside click or Escape.
 */
export function PlaybackConfig({
  speed,
  onSpeedChange,
  stepTicks,
  onStepChange,
}: {
  speed: number;
  onSpeedChange: (speed: number) => void;
  stepTicks: number;
  onStepChange: (ticks: number) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  useDialogEscape(open, () => setOpen(false));
  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            onClick={() => setOpen((o) => !o)}
            aria-label="Playback settings"
            aria-expanded={open}
            className="size-7"
          >
            <Settings className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Playback settings</TooltipContent>
      </Tooltip>

      {open && (
        <div
          role="dialog"
          aria-label="Playback settings"
          className="absolute bottom-full right-0 z-50 mb-2 w-56 rounded-md border border-border bg-popover p-3 text-popover-foreground shadow-md"
        >
          <Field label="Playback speed">
            <div className="grid grid-cols-5 gap-1">
              {SPEED_OPTIONS.map((s) => (
                <Segment
                  key={s}
                  active={speed === s}
                  onClick={() => onSpeedChange(s)}
                >
                  {s}×
                </Segment>
              ))}
            </div>
          </Field>
          <Field label="Skip amount" className="mt-3">
            <div className="grid grid-cols-4 gap-1">
              {STEP_OPTIONS.map((sec) => {
                const ticks = sec * TICKS_PER_SECOND;
                return (
                  <Segment
                    key={sec}
                    active={stepTicks === ticks}
                    onClick={() => onStepChange(ticks)}
                  >
                    {sec}s
                  </Segment>
                );
              })}
            </div>
          </Field>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className}>
      <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      {children}
    </div>
  );
}

function Segment({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded border px-1 py-1 text-xs font-medium tabular-nums transition-colors",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground",
      )}
    >
      {children}
    </button>
  );
}
