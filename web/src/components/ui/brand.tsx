import { cn } from "@/lib/cn";

/**
 * The ATLAS lockup — pure CSS/markup, no asset (handoff §10). A gradient rounded-square mark holding a
 * rotated bordered diamond, plus the "ATLAS" wordmark (Space Grotesk) and an optional mono caption.
 */
export function BrandLockup({
  size = "md",
  showCaption = false,
  className,
}: {
  size?: "sm" | "md" | "lg";
  showCaption?: boolean;
  className?: string;
}) {
  const mark = size === "lg" ? 40 : size === "md" ? 34 : 26;
  const diamond = Math.round(mark * 0.42);
  const word = size === "lg" ? 22 : size === "md" ? 21 : 15;

  return (
    <div className={cn("flex items-center gap-3", className)}>
      <span
        className="relative flex shrink-0 items-center justify-center rounded-[9px]"
        style={{
          width: mark,
          height: mark,
          background: "linear-gradient(145deg, var(--accent), var(--accent-2))",
          boxShadow: "0 4px 14px var(--accent-soft)",
        }}
        aria-hidden
      >
        <span
          className="block"
          style={{
            width: diamond,
            height: diamond,
            transform: "rotate(45deg)",
            border: "1.6px solid rgba(255,255,255,0.92)",
            borderRadius: 2,
          }}
        />
      </span>
      <div className="flex flex-col leading-none">
        <span
          className="font-disp font-bold text-text"
          style={{ fontSize: word, letterSpacing: "0.16em" }}
        >
          ATLAS
        </span>
        {showCaption ? (
          <span className="mt-1.5 font-mono text-[9px] uppercase tracking-[0.18em] text-faint">
            Coding-Agent Orchestrator
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** The 4-color Google "G" mark (verbatim provider SVG, handoff §10). */
export function GoogleG({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" aria-hidden>
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"
      />
    </svg>
  );
}
