import path from "node:path";
import type { NextConfig } from "next";

// Repo root, so the app can import ../shared (types + mock JSON).
const repoRoot = path.join(__dirname, "..");

const nextConfig: NextConfig = {
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
  // Root CLAUDE.md / AGENTS.md / GEMINI.md are the single source of agent rules.
  agentRules: false,
};

export default nextConfig;
