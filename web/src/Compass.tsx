export function Compass({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <circle cx="32" cy="32" r="30" fill="var(--ink)" />
      <circle cx="32" cy="32" r="22" fill="none" stroke="var(--lime)" strokeWidth="2.5" />
      <path d="M32 8 L37 32 L32 56 L27 32 Z" fill="#ffffff" />
      <path d="M8 32 L32 27 L56 32 L32 37 Z" fill="var(--blue)" />
      <circle cx="32" cy="32" r="3" fill="var(--ink)" />
    </svg>
  );
}
