import everroomLogo from '@/assets/nxcore-logo.svg'

export function ProductLogo({ className }: { className?: string }) {
  return (
    <img
      className={className}
      src={everroomLogo}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  )
}
