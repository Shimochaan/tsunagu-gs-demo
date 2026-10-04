import { build } from "esbuild";
import { mkdir, writeFile, copyFile } from "node:fs/promises";
await mkdir("build/public/assets", { recursive: true });
const result = await build({
  entryPoints: ["src/product/main.jsx"],
  bundle: true,
  format: "esm",
  minify: true,
  metafile: true,
  outdir: "build/public/assets",
  entryNames: "app-[hash]",
  assetNames: "app-[hash]",
  legalComments: "eof",
  define: { "process.env.NODE_ENV": '"production"' },
});
// モックのデータ・レビュー制御が本番依存へ紛れ込むとビルドを失敗させる。
for (const name of Object.keys(result.metafile.inputs))
  if (
    /(^|\/)(model\.json|data\.js|App\.jsx|Studio\.jsx|Structure\.jsx)$/.test(
      name,
    ) &&
    !name.startsWith("src/product/")
  )
    throw new Error(`Review-only module in production: ${name}`);

let jsFile = "";
let cssFile = "";
for (const out of Object.keys(result.metafile.outputs)) {
  if (out.endsWith(".js")) jsFile = "/" + out.replace(/^build\/public\//, "");
  if (out.endsWith(".css")) cssFile = "/" + out.replace(/^build\/public\//, "");
}

// Copy to unversioned fallback paths as well
if (jsFile) await copyFile(`build/public${jsFile}`, "build/public/assets/app.js");
if (cssFile) await copyFile(`build/public${cssFile}`, "build/public/assets/app.css");

const indexHtml = `<!doctype html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>TSUNAGU</title>
  <link rel="preload" href="${cssFile}" as="style">
  <link rel="stylesheet" href="${cssFile}">
  <link rel="modulepreload" href="${jsFile}">
  <style>
    body { margin: 0; background: #fdfcfe; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif; }
    .pt-skeleton-shell { display: flex; height: 100vh; }
    .pt-skeleton-side { width: 230px; border-right: 1px solid #ece9f1; padding: 24px; box-sizing: border-box; display: flex; flex-direction: column; gap: 16px; background: #fff; }
    .pt-skeleton-main { flex: 1; padding: 32px; box-sizing: border-box; background: #fdfcfe; }
    .pt-skeleton-bar { height: 12px; background: #f1eff5; border-radius: 6px; animation: pt-pulse 1.2s ease-in-out infinite; }
    @keyframes pt-pulse { 0%, 100% { opacity: 0.7; } 50% { opacity: 0.3; } }
    @media (max-width: 900px) { .pt-skeleton-side { display: none; } }
  </style>
</head>
<body>
  <div id="root">
    <div class="pt-skeleton-shell" aria-hidden="true">
      <div class="pt-skeleton-side">
        <div class="pt-skeleton-bar" style="width: 80px; height: 20px;"></div>
        <div style="margin-top: 24px; display: flex; flex-direction: column; gap: 12px;">
          <div class="pt-skeleton-bar" style="width: 100%;"></div>
          <div class="pt-skeleton-bar" style="width: 85%;"></div>
          <div class="pt-skeleton-bar" style="width: 90%;"></div>
        </div>
      </div>
      <div class="pt-skeleton-main">
        <div class="pt-skeleton-bar" style="width: 140px; height: 24px; margin-bottom: 24px;"></div>
        <div class="pt-skeleton-bar" style="width: 60%; height: 16px; margin-bottom: 32px;"></div>
        <div class="pt-skeleton-bar" style="width: 100%; height: 200px; border-radius: 12px;"></div>
      </div>
    </div>
  </div>
  <script type="module" src="${jsFile}"></script>
</body>
</html>`;

await writeFile("build/public/index.html", indexHtml);
await writeFile(
  "build/metafile.json",
  JSON.stringify(result.metafile, null, 2),
);
await copyFile(
  "THIRD_PARTY_NOTICES.md",
  "build/public/THIRD_PARTY_NOTICES.txt",
);
console.log(`Production app built: ${jsFile}, ${cssFile}`);

await import("./build-demo-guide.mjs");
