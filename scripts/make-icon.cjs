// Renders apps/desktop/resources/icon.svg into a multi-size Windows icon.ico
// and a 256px icon.png used by the Electron window and the installer.
const fs = require("node:fs");
const path = require("node:path");
const { Resvg } = require("@resvg/resvg-js");
const pngToIcoModule = require("png-to-ico");
const pngToIco = typeof pngToIcoModule === "function" ? pngToIcoModule : pngToIcoModule.default;

const resourcesDir = path.join(__dirname, "..", "apps", "desktop", "resources");
const svg = fs.readFileSync(path.join(resourcesDir, "icon.svg"), "utf8");

const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = sizes.map((size) => {
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: size } });
  return resvg.render().asPng();
});

fs.writeFileSync(path.join(resourcesDir, "icon.png"), pngs[pngs.length - 1]);

pngToIco(pngs)
  .then((buffer) => {
    fs.writeFileSync(path.join(resourcesDir, "icon.ico"), buffer);
    console.log("Wrote icon.ico and icon.png to", resourcesDir);
  })
  .catch((error) => {
    console.error("Icon generation failed:", error);
    process.exit(1);
  });
