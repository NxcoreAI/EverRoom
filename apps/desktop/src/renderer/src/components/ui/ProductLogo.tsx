export function ProductLogo({ className }: { className?: string }) {
  return (
    <img
      className={className}
      src="/icons/nexcore-logo.png"
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  )
}
