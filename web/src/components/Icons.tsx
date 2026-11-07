import React from "react";

export function TimelineCrosshairIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 32 32" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M12.5 3.5a13 13 0 0 0-9 9m0 7a13 13 0 0 0 9 9m7 0a13 13 0 0 0 9-9m0-7a13 13 0 0 0-9-9" />
      <path d="M16 3v7m0 12v7M3 16h7m12 0h7" />
    </svg>
  );
}

export function LiveRingsIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="6.8" />
      <circle cx="12" cy="12" r="10.2" strokeDasharray="2.2 3.1" />
    </svg>
  );
}

export function AspectRatioGlyph() {
  return (
    <svg width="16" height="18" viewBox="0 0 24 28" fill="currentColor" aria-hidden="true">
      <path d="M8.5 0h7c.8 0 1.2.8.7 1.5L12.8 6c-.4.6-1.2.6-1.6 0L7.8 1.5C7.3.8 7.7 0 8.5 0ZM8.5 28h7c.8 0 1.2-.8.7-1.5L12.8 22c-.4-.6-1.2-.6-1.6 0l-3.4 4.5c-.5.7-.1 1.5.7 1.5Z" />
      <rect
        x="2"
        y="7.5"
        width="20"
        height="13"
        rx="2.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.6"
      />
    </svg>
  );
}

export function SkipSecondsGlyph({ forward = false }: { forward?: boolean }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <g transform={forward ? "translate(24 0) scale(-1 1)" : undefined}>
        <path d="M3.3 7.8a9.5 9.5 0 1 1-.7 7.2" />
        <path d="M3 3.5V8h4.5" />
      </g>
      <path
        d="M14.2 8.2h-4.1l-.4 3.6c.6-.5 1.2-.7 2-.7 1.6 0 2.7.9 2.7 2.4s-1.1 2.5-2.6 2.5c-1 0-1.8-.4-2.2-1.1"
        strokeWidth="1.5"
      />
    </svg>
  );
}

export function ActionButton({
  children,
  onClick,
  variant = "default",
  className = "",
  title,
  disabled = false,
  type = "button",
}: {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: "default" | "primary" | "subtle" | "danger";
  className?: string;
  title?: string;
  disabled?: boolean;
  type?: "button" | "submit";
}) {
  const variantClass =
    variant === "primary"
      ? "btn-primary"
      : variant === "subtle"
        ? "btn-subtle"
        : variant === "danger"
          ? "btn-danger"
          : "";
  return (
    <button
      type={type}
      className={`btn ${variantClass} ${className}`.trim()}
      onClick={onClick}
      title={title}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

export function RoundIconButton({
  children,
  onClick,
  title,
  className = "",
  disabled = false,
  active = false,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  className?: string;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      className={`icon-btn ${active ? "is-active" : ""} ${className}`.trim()}
      onClick={onClick}
      aria-label={title}
      title={title}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
