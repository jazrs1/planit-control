"use client";

import type { Site } from "@shared/types";
import SitePicker from "@/components/SitePicker";
import { timeZoneName } from "@/lib/time";

// Crew view: the shared site picker, large, remembering the choice on this device (lib/crew.ts).

type CrewSitePickerProps = {
  sites: Site[] | null;
  selectedId: string | null;
  onSelect: (siteId: string) => void;
  disabled?: boolean;
};

export default function CrewSitePicker({ sites, selectedId, onSelect, disabled = false }: CrewSitePickerProps) {
  const selected = sites?.find((site) => site.id === selectedId) ?? null;
  return (
    <SitePicker
      sites={sites} selectedId={selectedId} onSelect={(id) => { if (id) onSelect(id); }} disabled={disabled}
      label="Your site" size="large" remember
      hint={selected ? `${selected.county} County · ${timeZoneName(selected.timezone)}` : null}
    />
  );
}
