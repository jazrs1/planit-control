// Rebuild with: node scripts/generate-app-icons.cjs [dashboard-map-capture.png]
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
  // brand and bg are plain hex in tokens.css (the manifest reads them too); the other tokens use
  // light-dark()/oklch, which SVG rasterizers can't read, so the icon uses their plain equivalents.
  const brand = color("brand"), background = color("bg");
  const surface = "#f6f5f1", accent = "#facc15";
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
  // The social card is built from a dashboard map capture: node scripts/generate-app-icons.cjs <map.png>
  const capture = process.argv[2];
  if (capture) {
    const card = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
      <defs><linearGradient id="fade" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${background}" stop-opacity="0.97"/><stop offset="0.55" stop-color="${background}" stop-opacity="0.85"/><stop offset="1" stop-color="${background}" stop-opacity="0"/></linearGradient></defs>
      <rect x="470" width="300" height="630" fill="url(#fade)"/>
      <rect x="72" y="200" width="112" height="112" rx="24" fill="${brand}"/><g transform="translate(72 200) scale(.21875)">${artwork}</g>
      <g font-family="Helvetica Neue,Arial,sans-serif" fill="${brand}">
        <text x="72" y="392" font-size="64" font-weight="600" letter-spacing="-1">Fieldcast</text>
        <text x="74" y="446" font-size="30" fill="#5d5a52">Live job-site safety for Florida utility crews</text>
        <text x="74" y="540" font-size="22" fill="#7b776c">stormsafecrews.us</text>
      </g></svg>`;
    // The map on the right (Florida, cropped from the capture), the name and one line on the left.
    // From a 1440x900 desktop capture with the panels hidden: the peninsula and the map attribution.
    const map = await sharp(capture).extract({ left: 260, top: 0, width: 930, height: 802 }).resize(730, 630).png().toBuffer();
    await sharp({ create: { width: 1200, height: 630, channels: 4, background } })
      .composite([{ input: map, left: 470, top: 0 }, { input: Buffer.from(card) }]).png().toFile(path.join(root, "public/social-preview.png"));
  }
  console.log(`Generated SVG, home-screen PNGs and favicon${capture ? ", and the social preview" : ""} from styles/tokens.css`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
