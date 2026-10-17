import NotificationSettings from "@/components/NotificationSettings";
import { getSites, orNull } from "@/lib/api";
import { pageMetadata } from "@/lib/metadata";

export const metadata = pageMetadata("Notification settings", "Choose sites and a role for device alerts, test delivery, or unsubscribe.");

export default async function SettingsPage() {
  return <NotificationSettings initialSites={await orNull(getSites())} />;
}
