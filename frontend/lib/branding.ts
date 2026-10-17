import { readFileSync } from "node:fs";
import path from "node:path";

// Manifest and browser chrome cannot use CSS variables; read their source tokens.
const tokens = readFileSync(path.join(process.cwd(), "styles/tokens.css"), "utf8");
function color(name: string) {
  const value = tokens.match(new RegExp(`--pc-${name}:\\s*([^;]+);`))?.[1].trim();
  if (!value) throw new Error(`Missing app color token: ${name}`);
  return value;
}
export const APP_COLORS = { theme: color("brand"), background: color("bg") };
