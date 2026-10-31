import type React from "react";

export function Button({
  children,
  onClick,
  className = "",
  title,
  disabled = false,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  className?: string;
  title?: string;
  disabled?: boolean;
}) {
  return (
    <button
      className={`button ${className}`}
      onClick={onClick}
      title={title}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
export function IconButton({
  children,
  onClick,
  title,
  className = "",
  disabled = false,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <button
      className={`icon-button ${className}`}
      onClick={onClick}
      aria-label={title}
      title={title}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
