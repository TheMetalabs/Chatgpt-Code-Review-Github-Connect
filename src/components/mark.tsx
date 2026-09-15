import { cn } from "@/lib/utils";

export function Mark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={cn("size-7", className)}
      aria-hidden="true"
    >
      <path
        d="M6 26V8l16 18H6Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="miter"
      />
      <path d="M6 26h18" stroke="currentColor" strokeWidth="1.6" />
      <path d="M6 20h6" stroke="currentColor" strokeWidth="1.2" opacity="0.7" />
    </svg>
  );
}
