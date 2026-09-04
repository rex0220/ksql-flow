import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { builtinModules, createRequire } from "node:module";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import { build } from "esbuild";
import postject from "postject";

const { inject } = postject;
const require = createRequire(import.meta.url);
const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const ZIP_TIMESTAMP = new Date("2020-01-01T00:00:00.000Z");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.version;
const engineRange = pkg.dependencies?.["@rex0220/kintone-sql-tools"];
const outDir = join(root, "dist-bin");
const workDir = join(outDir, ".build-win-binary");
const bundlePath = join(workDir, "ksql-flow.cjs");
const seaConfigPath = join(workDir, "sea-config.json");
const blobPath = join(workDir, "ksql-flow.blob");
const exeName = "ksql-flow.exe";
const exePath = join(outDir, exeName);
const zipName = `ksql-flow-v${version}-win-x64.zip`;
const zipPath = join(outDir, zipName);
const sumsPath = join(outDir, "SHA256SUMS.txt");

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error(
    `Windows x64 上で実行してください（現在: ${process.platform}-${process.arch}）。` +
      "SEA はビルドに使用した Node ランタイムを複製します。"
  );
}
if (!existsSync(join(root, "dist", "cli.js"))) {
  throw new Error("dist/cli.js がありません。先に npm run build を実行してください。");
}

mkdirSync(outDir, { recursive: true });
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });
for (const artifact of [exePath, zipPath, sumsPath]) {
  rmSync(artifact, { force: true });
}

console.log(`[1/6] esbuild: dist/cli.js -> ${bundlePath}`);
const bundle = await build({
  absWorkingDir: root,
  stdin: {
    contents: readFileSync(join(root, "dist", "cli.js"), "utf8"),
    resolveDir: join(root, "dist"),
    sourcefile: "dist/cli.js",
    loader: "js",
  },
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  minify: false,
  legalComments: "inline",
  write: false,
  plugins: [nodeFileSystemPlugin()],
  logLevel: "info",
});
writeFileSync(bundlePath, bundle.outputFiles[0].contents);

console.log(`[2/6] Node SEA blob (${process.version})`);
writeFileSync(
  seaConfigPath,
  `${JSON.stringify(
    {
      main: basename(bundlePath),
      output: basename(blobPath),
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
    },
    null,
    2
  )}\n`,
  "utf8"
);
run(process.execPath, [`--experimental-sea-config=${seaConfigPath}`], { cwd: workDir });

console.log(`[3/6] postject: ${exeName}`);
copyFileSync(process.execPath, exePath);
stripPeCertificateTable(exePath);
await inject(exePath, "NODE_SEA_BLOB", readFileSync(blobPath), {
  sentinelFuse: SEA_FUSE,
  overwrite: true,
});

console.log("[4/6] executable smoke tests");
const verificationDir = mkdtempSync(join(tmpdir(), "ksql-flow-sea-smoke-"));
try {
  const smokeSql = join(root, "test", "fixtures", "package-smoke", "smoke.sql");
  const smokeConfig = join(verificationDir, "ksql.config.json");
  writeFileSync(
    smokeConfig,
    `${JSON.stringify({
      defaultProfile: "offline",
      profiles: {
        offline: {
          baseUrl: "https://offline.invalid",
          auth: { type: "apiToken" },
          apps: {},
        },
      },
    })}\n`,
    "utf8"
  );

  verify("(a) --help", ["--help"], 0, verificationDir, /kSQL Flow/);
  const noConfigDir = join(verificationDir, "no-config");
  mkdirSync(noConfigDir);
  verify("(b) config missing validate -f", ["validate", "-f", smokeSql], 1, noConfigDir, /設定ファイル/);
  verify("(c) unknown --dryrun", ["run", "-f", smokeSql, "--dryrun"], 1, verificationDir, /未知または不適用/);
  verify(
    "(d) offline package-smoke validate",
    ["validate", "-f", smokeSql, "--config", smokeConfig],
    0,
    verificationDir,
    /smoke\.sql: OK/
  );
  verify("(e) resultCsv capability", ["capabilities", "--json"], 0, verificationDir, /"resultCsv":true/);

  const exportSql = join(verificationDir, "export.sql");
  const exportCsv = join(verificationDir, "export-sjis.csv");
  writeFileSync(exportSql, "SELECT '日本語①Ⅰ髙﨑～' AS value;\n", "utf8");
  verify(
    "(f) offline Shift_JIS export",
    ["run", "-f", exportSql, "--config", smokeConfig, "--lock", "local-only",
      "--export-csv", exportCsv, "--export-encoding", "sjis"],
    0,
    verificationDir,
    /SUCCESS/
  );
  const exportedText = new TextDecoder("shift_jis", { fatal: true }).decode(readFileSync(exportCsv));
  if (exportedText !== "value\r\n日本語①Ⅰ髙﨑～\r\n") {
    throw new Error("(f) offline Shift_JIS export: byte round-trip mismatch");
  }

  const invalidSql = join(verificationDir, "export-invalid-sjis.sql");
  const invalidCsv = join(verificationDir, "export-invalid-sjis.csv");
  writeFileSync(invalidSql, "SELECT '😀' AS value;\n", "utf8");
  verify(
    "(g) unrepresentable Shift_JIS fails closed",
    ["run", "-f", invalidSql, "--config", smokeConfig, "--lock", "local-only",
      "--export-csv", invalidCsv, "--export-encoding", "sjis"],
    1,
    verificationDir,
    /U\+1F600/
  );
  if (existsSync(invalidCsv)) throw new Error("(g) unrepresentable Shift_JIS created a completed file");
} finally {
  rmSync(verificationDir, { recursive: true, force: true });
}

console.log(`[5/6] package: ${zipName}`);
const readme = [
  `kSQL Flow v${version}`,
  `Compatible engine: @rex0220/kintone-sql-tools ${engineRange}`,
  "AS-IS: no support or warranty; see LICENSE.",
].join("\r\n") + "\r\n";
const zip = new AdmZip();
zip.addFile(exeName, readFileSync(exePath));
zip.addFile("LICENSE", readFileSync(join(root, "LICENSE")));
zip.addFile("README.txt", Buffer.from(readme, "utf8"));
for (const entry of zip.getEntries()) {
  entry.header.time = ZIP_TIMESTAMP;
}
zip.writeZip(zipPath);

console.log("[6/6] SHA-256");
const exeHash = sha256(exePath);
const zipHash = sha256(zipPath);
writeFileSync(
  sumsPath,
  `${zipHash}  ${basename(zipPath)}\r\n${exeHash}  ${basename(exePath)}\r\n`,
  "ascii"
);
rmSync(workDir, { recursive: true, force: true });

console.log(`DONE ${zipPath} (${formatBytes(statSync(zipPath).size)})`);
console.log(`     ${exePath} (${formatBytes(statSync(exePath).size)})`);
console.log(`     SHA256(zip) ${zipHash}`);
console.log(`     SHA256(exe) ${exeHash}`);

function verify(label, args, expectedExit, cwd, outputPattern) {
  const result = spawnSync(exePath, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== expectedExit || !outputPattern.test(output)) {
    throw new Error(
      `${label}: expected Exit ${expectedExit} and ${outputPattern}, got Exit ${result.status}\n${output}`
    );
  }
  console.log(`  PASS ${label}: Exit ${result.status}`);
}

function run(command, args, options) {
  const result = spawnSync(command, args, {
    ...options,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${basename(command)} ${args.join(" ")} failed with Exit ${result.status}`);
  }
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function formatBytes(bytes) {
  return `${bytes.toLocaleString("en-US")} bytes`;
}

/**
 * node.exe の Authenticode 署名は SEA blob 注入後には無効になるため、先に除去する。
 * Windows SDK の signtool に依存せず、PE Optional Header の Certificate Table を消去する。
 */
function stripPeCertificateTable(file) {
  let executable = readFileSync(file);
  if (executable.toString("ascii", 0, 2) !== "MZ") {
    throw new Error(`${file} は PE executable ではありません`);
  }
  const peOffset = executable.readUInt32LE(0x3c);
  if (executable.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0") {
    throw new Error(`${file} の PE header が不正です`);
  }
  const optionalHeader = peOffset + 24;
  const magic = executable.readUInt16LE(optionalHeader);
  const dataDirectory = optionalHeader + (magic === 0x20b ? 112 : magic === 0x10b ? 96 : -1);
  if (dataDirectory < optionalHeader) {
    throw new Error(`${file} の PE optional header magic が未対応です: 0x${magic.toString(16)}`);
  }
  const certificateEntry = dataDirectory + 4 * 8;
  const certificateOffset = executable.readUInt32LE(certificateEntry);
  const certificateSize = executable.readUInt32LE(certificateEntry + 4);
  if (certificateOffset === 0 || certificateSize === 0) return;
  if (certificateOffset + certificateSize > executable.length) {
    throw new Error(`${file} の PE certificate table がファイル範囲外です`);
  }
  executable.fill(0, certificateEntry, certificateEntry + 8);
  if (certificateOffset + certificateSize === executable.length) {
    executable = executable.subarray(0, certificateOffset);
  }
  writeFileSync(file, executable);
}

/**
 * esbuild の子プロセスにファイル探索を任せず、Node 側で解決・読込する。
 * 通常環境だけでなく、親ディレクトリ探索が制限されたビルド環境でも同じ入力をバンドルできる。
 */
function nodeFileSystemPlugin() {
  const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
  return {
    name: "node-filesystem",
    setup(esbuild) {
      esbuild.onResolve({ filter: /.*/ }, (args) => {
        const bareName = args.path.replace(/^node:/, "");
        if (builtins.has(bareName)) return { path: args.path, external: true };
        const paths = args.resolveDir ? [args.resolveDir] : [root];
        const file = require.resolve(args.path, { paths });
        return {
          path: relative(root, file).replaceAll("\\", "/"),
          namespace: "node-filesystem",
          pluginData: { file },
        };
      });
      esbuild.onLoad({ filter: /.*/, namespace: "node-filesystem" }, (args) => {
        const file = args.pluginData.file;
        const extension = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
        if (extension === "node") {
          throw new Error(`ネイティブ addon は単一バイナリへバンドルできません: ${file}`);
        }
        return {
          contents: readFileSync(file),
          loader: extension === "json" ? "json" : "js",
          resolveDir: dirname(file),
        };
      });
    },
  };
}
