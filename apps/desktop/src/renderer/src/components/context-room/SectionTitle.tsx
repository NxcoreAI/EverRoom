export function SectionTitle({ label, title }: { label: string; title: string }) {
  return (
    <div className="cr-section-title">
      <span>{label}</span>
      <h2>{title}</h2>
    </div>
  )
}
