// UMD 打包:产出 dist/camera-angle-studio.umd.js(挂 window.CameraAngleStudioPlugin)
// 注意:画布宿主加载插件走 ESM(dist/camera-angle-studio.js),UMD 产物作为独立交付/演示用,
// 供非宿主环境(如 script 标签直接引入)使用。UMD 打包不 external react(自带 React 副本),
// 仅用于独立页面演示,不会注入宿主。
import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const outfile = join(root, "dist", "camera-angle-studio.umd.js");
await mkdir(dirname(outfile), { recursive: true });

await build({
    entryPoints: [join(root, "src", "index.tsx")],
    outfile,
    bundle: true,
    format: "iife",
    globalName: "CameraAngleStudioPlugin",
    jsx: "automatic",
    jsxImportSource: "@infinite-canvas/plugin-sdk",
    loader: { ".ts": "ts", ".tsx": "tsx" },
    // UMD 演示包自带 React,不 external
    define: { "process.env.NODE_ENV": '"production"' },
    minify: true,
    target: "es2020",
});

console.log(`[camera-angle-studio] UMD built → dist/camera-angle-studio.umd.js`);
