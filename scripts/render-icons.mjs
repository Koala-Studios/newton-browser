import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const root = process.cwd();
const icons = path.join(root, "apps", "extension", "icons");
const master = path.join(icons, "icon-generated-v2.png");
const output = [16, 32, 48, 128].map((size) => ({ name: `icon-${size}.png`, size }));

if (!fs.existsSync(master)) throw new Error(`missing transparent master icon: ${master}`);
const cleanMaster = await cleanTransparentMaster();
await Promise.all(output.map(({ name, size }) => writePng(path.join(icons, name), iconAtSize(size))));
await Promise.all([16, 32].flatMap((size) => [
  writePng(path.join(icons, `action-connected-${size}.png`), iconAtSize(size)),
  writePng(path.join(icons, `action-disconnected-${size}.png`), iconAtSize(size).grayscale().tint("#64748B")),
]));

if (process.argv.includes("--contact-sheet")) await renderContactSheet();
process.stdout.write(`${JSON.stringify({ ok: true, icons: output.map(({ name }) => name) })}\n`);

async function writePng(file, image) {
  await image.png({ compressionLevel: 9, adaptiveFiltering: false }).toFile(file);
}

function iconAtSize(size) {
  return sharp(cleanMaster).resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } });
}

async function cleanTransparentMaster() {
  const { data, info } = await sharp(master).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let left = info.width;
  let top = info.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const offset = (y * info.width + x) * info.channels;
      const red = data[offset];
      const green = data[offset + 1];
      const blue = data[offset + 2];
      if (red < 12 && green < 12 && blue < 12) data[offset + 3] = 0;
      if (data[offset + 3] <= 10) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < left || bottom < top) throw new Error("transparent master icon has no visible pixels");
  return sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
    .extract({ left, top, width: right - left + 1, height: bottom - top + 1 })
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toBuffer();
}

async function renderContactSheet() {
  const destination = path.join(root, "test", "evidence", "runs", "ws2-icon-contact-sheet.png");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const sizes = [16, 32, 48, 128];
  const backgrounds = ["#F8FAFC", "#0F172A"];
  const composites = [];
  for (const [row, background] of backgrounds.entries()) {
    const top = row * 190;
    composites.push({ input: Buffer.from(`<svg width="768" height="190" xmlns="http://www.w3.org/2000/svg"><rect width="768" height="190" fill="${background}"/></svg>`), left: 0, top });
    for (const [column, size] of sizes.entries()) {
      const left = 64 + column * 176;
      const color = row === 0 ? "#0F172A" : "#F8FAFC";
      const label = Buffer.from(`<svg width="128" height="24" xmlns="http://www.w3.org/2000/svg"><text x="64" y="17" text-anchor="middle" font-family="Arial, sans-serif" font-size="14" fill="${color}">${size}px</text></svg>`);
      const rendered = await sharp(path.join(icons, `icon-${size}.png`)).png().toBuffer();
      composites.push({ input: label, left, top: top + 14 });
      composites.push({ input: rendered, left: left + (128 - size) / 2, top: top + 46 + (128 - size) / 2 });
    }
  }
  composites.push({ input: Buffer.from('<svg width="768" height="96" xmlns="http://www.w3.org/2000/svg"><rect width="768" height="96" fill="#E2E8F0"/></svg>'), left: 0, top: 380 });
  for (const [index, state] of ["connected", "disconnected"].entries()) {
    const left = 236 + index * 170;
    const label = Buffer.from(`<svg width="150" height="22" xmlns="http://www.w3.org/2000/svg"><text x="75" y="16" text-anchor="middle" font-family="Arial, sans-serif" font-size="14" fill="#0F172A">Toolbar: ${state}</text></svg>`);
    const rendered = await sharp(path.join(icons, `action-${state}-32.png`)).png().toBuffer();
    composites.push({ input: label, left, top: 392 });
    composites.push({ input: rendered, left: left + 59, top: 430 });
  }
  await sharp({ create: { width: 768, height: 476, channels: 4, background: "#FFFFFF" } }).composite(composites).png().toFile(destination);
}
