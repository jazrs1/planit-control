import type { ReportCategory, ReporterRole } from "@shared/types";

// Species are preserved in the note because the API has one wildlife category.
export const REPORT_OPTIONS = [
  { label: "Alligator", category: "wildlife" },
  { label: "Snake", category: "wildlife" },
  { label: "Other wildlife", category: "wildlife" },
  { label: "Flooding or washout", category: "flooding" },
  { label: "Downed line", category: "downed_line" },
  { label: "Heat illness", category: "heat_illness" },
  { label: "Other", category: "other" },
] as const satisfies ReadonlyArray<{ label: string; category: ReportCategory }>;

export const REPORT_LABEL: Record<ReportCategory, string> = {
  downed_line: "Downed line", flooding: "Flooding or washout", wildlife: "Wildlife",
  fire_smoke: "Fire or smoke", heat_illness: "Heat illness", unsafe_ground: "Unsafe ground", other: "Other",
};

export const ROLE_LABEL: Record<ReporterRole, string> = {
  crew_member: "Crew member", foreman: "Foreman", safety_officer: "Safety officer",
};
