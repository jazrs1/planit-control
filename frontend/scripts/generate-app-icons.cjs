// Rebuild with: node scripts/generate-app-icons.cjs
// sharp is already installed by Next.js; no additional package is required.
const fs = require("node:fs/promises");
const path = require("node:path");
const sharp = require("sharp");
const root = path.resolve(__dirname, "..");

async function main() {
  const tokens = await fs.readFile(path.join(root, "styles/tokens.css"), "utf8");
  const color = name => {
    const value = tokens.match(new RegExp(`--pc-${name}:\\s*([^;]+);`))?.[1].trim();
    if (!value) throw new Error(`Missing icon color token: ${name}`);
    return value;
  };
  const brand = color("brand"), surface = color("surface"), accent = color("lightning"), background = color("bg"), text = color("text"), muted = color("text-muted");
  const artwork = `<path d="M256 104 374 152v96c0 76-49 128-118 164-69-36-118-88-118-164v-96z" fill="none" stroke="${surface}" stroke-width="22" stroke-linejoin="round"/><path d="m275 166-80 112h62l-20 78 84-126h-64z" fill="${accent}"/>`;
  const svg = rounded => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="${rounded ? 96 : 0}" fill="${brand}"/>${artwork}</svg>`;
  const icons = path.join(root, "public/icons");
  await fs.mkdir(icons, { recursive: true });
  await fs.writeFile(path.join(root, "app/icon.svg"), svg(true));
  for (const [filename, size, rounded] of [["icon-192.png", 192, true], ["icon-512.png", 512, true], ["maskable-512.png", 512, false], ["apple-touch-icon.png", 180, false]]) {
    await sharp(Buffer.from(svg(rounded))).resize(size, size).png().toFile(path.join(icons, filename));
  }
  const png = await sharp(Buffer.from(svg(true))).resize(32, 32).png().toBuffer();
  const ico = Buffer.alloc(22);
  ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4);
  ico[6] = 32; ico[7] = 32; ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12);
  ico.writeUInt32LE(png.length, 14); ico.writeUInt32LE(22, 18);
  await fs.writeFile(path.join(root, "app/favicon.ico"), Buffer.concat([ico, png]));
  const social = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630"><rect width="1200" height="630" fill="${background}"/><rect x="60" y="155" width="300" height="300" rx="56" fill="${brand}"/><g transform="translate(60 155) scale(.5859375)">${artwork}</g><g font-family="Segoe UI,Arial,sans-serif"><text x="410" y="270" fill="${brand}" font-size="66" font-weight="700">PlanIT Control</text><text x="414" y="340" fill="${text}" font-size="34">Job-site safety for field crews</text><text x="414" y="400" fill="${muted}" font-size="26">Site conditions · Alerts · Hazard reports</text></g></svg>`;
  await sharp(Buffer.from(social)).png().toFile(path.join(root, "public/social-preview.png"));
  console.log("Generated SVG, home-screen PNGs, favicon, and social preview from styles/tokens.css");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
