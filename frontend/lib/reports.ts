import type { ReportCategory, ReporterRole } from "@shared/types";

// Wildlife options carry a species (CreateReportRequest.species); the API has one wildlife category.
export const REPORT_OPTIONS = [
  { label: "Alligator", category: "wildlife", species: "Alligator" },
  { label: "Snake", category: "wildlife", species: "Snake" },
  { label: "Other wildlife", category: "wildlife", species: null },
  { label: "Flooding or washout", category: "flooding" },
  { label: "Downed line", category: "downed_line" },
  { label: "Heat illness", category: "heat_illness" },
  { label: "Fire or smoke", category: "fire_smoke" },
  { label: "Unsafe ground", category: "unsafe_ground" },
  { label: "Other", category: "other" },
] as const satisfies ReadonlyArray<{ label: string; category: ReportCategory; species?: string | null }>;

export const REPORT_LABEL: Record<ReportCategory, string> = {
  downed_line: "Downed line", flooding: "Flooding or washout", wildlife: "Wildlife",
  fire_smoke: "Fire or smoke", heat_illness: "Heat illness", unsafe_ground: "Unsafe ground", other: "Other",
};

export const ROLE_LABEL: Record<ReporterRole, string> = {
  crew_member: "Crew member", foreman: "Foreman", safety_officer: "Safety officer",
};
