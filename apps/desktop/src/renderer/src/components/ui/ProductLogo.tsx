import everroomAppIcon from '@/assets/everroom-app-icon.png'
import everroomFullLogo from '@/assets/everroom-full.png'

export function ProductLogo({
  className,
  variant = 'icon',
}: {
  className?: string
  variant?: 'full' | 'icon'
}) {
  return (
    <img
      className={className}
      src={variant === 'full' ? everroomFullLogo : everroomAppIcon}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  )
}
