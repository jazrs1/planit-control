// Grey placeholders in the shape of each page, shown by the routes' loading.tsx while the server
// fetches live data. Never used for safety status: those show "Connecting…" / unknown, not shapes.

function Line({ className }: { className: string }) {
  return <div className={`pc-skeleton pc-skeleton--line ${className}`} />;
}

function Loading({ label, className, children }: { label: string; className: string; children: React.ReactNode }) {
  return <main role="status" aria-busy="true" className={className}>
    <span className="sr-only">{label}</span>
    <div aria-hidden="true" className="contents">{children}</div>
  </main>;
}

function Rows({ count }: { count: number }) {
  return <div className="divide-y divide-border/70">{Array.from({ length: count }, (_, i) => <div key={i} className="flex items-center gap-3 py-4">
    <div className="pc-skeleton h-6 w-12" />
    <div className="flex-1 space-y-2"><Line className="w-2/3 text-sm" /><Line className="w-1/3 text-xs" /></div>
  </div>)}</div>;
}

/** The dashboard: the map, then the site panel (title, stat strip, search, rows). */
export function DashboardSkeleton() {
  return <Loading label="Loading sites…" className="relative flex flex-col lg:block lg:h-[calc(100dvh-var(--pc-nav-height)-var(--pc-outage-height,0px))] lg:overflow-clip">
    <div className="pc-skeleton h-[min(56svh,30rem)] min-h-80 rounded-none lg:absolute lg:inset-0 lg:h-auto" />
    <div className="flex flex-col gap-5 bg-surface p-5 lg:pc-float lg:absolute lg:inset-bs-3 lg:inset-be-3 lg:inset-e-3 lg:w-(--pc-rail-width)">
      <div className="space-y-2"><Line className="w-36 text-xl" /><Line className="w-28 text-xs" /></div>
      <div className="grid grid-cols-5 gap-3">{Array.from({ length: 5 }, (_, i) => <div key={i} className="space-y-2"><Line className="w-10 text-xs" /><div className="pc-skeleton h-7 w-8" /></div>)}</div>
      <div className="pc-skeleton h-11" />
      <Rows count={6} />
    </div>
  </Loading>;
}

/** The crew view: heading, site picker, hazard index card, then the readings. */
export function CrewSkeleton() {
  return <Loading label="Loading your site…" className="mx-auto max-w-2xl space-y-5 px-4 py-5">
    <Line className="w-56 text-3xl" />
    <div className="pc-skeleton h-36" />
    <div className="pc-skeleton h-60" />
    <div className="grid grid-cols-2 gap-3">{Array.from({ length: 4 }, (_, i) => <div key={i} className="pc-skeleton h-40" />)}</div>
  </Loading>;
}

/** A content page: title, a line under it, then cards in a grid. */
export function PageSkeleton({ label, cards = 4, columns = "sm:grid-cols-2", cardHeight = "h-44", width = "max-w-5xl" }: { label: string; cards?: number; columns?: string; cardHeight?: string; width?: string }) {
  return <Loading label={label} className={`mx-auto flex ${width} flex-col gap-6 px-4 pbs-8 pbe-12 sm:px-6`}>
    <div className="space-y-3"><Line className="w-64 text-3xl" /><Line className="w-80 max-w-full text-sm" /></div>
    <div className={`grid gap-4 ${columns}`}>{Array.from({ length: cards }, (_, i) => <div key={i} className={`pc-skeleton ${cardHeight}`} />)}</div>
  </Loading>;
}
