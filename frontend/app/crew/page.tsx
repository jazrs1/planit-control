import CrewView from "@/components/CrewView";
import { getSites, orNull } from "@/lib/api";

export default async function CrewPage() {
  return <CrewView initialSites={await orNull(getSites())} />;
}
