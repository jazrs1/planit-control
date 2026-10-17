import { pageMetadata } from "@/lib/metadata";
import CrewView from "@/components/CrewView";
import { getSites, orNull } from "@/lib/api";

export const metadata = pageMetadata("Crew view", "Choose your job site for live safety status, key readings, tomorrow's briefing, and hazard reporting.");

export default async function CrewPage() {
  return <CrewView initialSites={await orNull(getSites())} />;
}
