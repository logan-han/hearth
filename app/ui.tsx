export function Stat({ value, label, note }: { value: number | string; label: string; note?: string }) {
  return (
    <div className="stat">
      <b>{typeof value === 'number' ? value.toLocaleString('en-AU') : value}</b>
      <span>{label}</span>
      {note ? <em>{note}</em> : null}
    </div>
  )
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="empty">{children}</p>
}
