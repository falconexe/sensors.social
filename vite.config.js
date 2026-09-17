import { fileURLToPath, URL } from "node:url";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";

import prerender from "@prerenderer/rollup-plugin";
import vue from "@vitejs/plugin-vue";
import Markdown from "unplugin-vue-markdown/vite";
import { defineConfig, transformWithEsbuild } from "vite";
import fg from "fast-glob";

function findSensorsSocialCryptoDir() {
  const candidates = [
    fileURLToPath(new URL("./node_modules/@sensors-social/crypto/packages/crypto/", import.meta.url)),
    fileURLToPath(new URL("./node_modules/@sensors-social/crypto/", import.meta.url)),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "src", "aesgcm.ts"))) return dir;
  }
  return null;
}

const CRYPTO_DIR = findSensorsSocialCryptoDir();
const CRYPTO_SRC = (CRYPTO_DIR || "").replace(/\\/g, "/");
const CRYPTO_SRC_ALIAS = CRYPTO_DIR
  ? path.resolve(CRYPTO_DIR, "src").replace(/\\/g, "/")
  : null;

function resolveCryptoSource(id) {
  const match = id.match(/^@sensors-social\/crypto\/(?:packages\/crypto\/)?src\/(.+)$/);
  if (!match || !CRYPTO_DIR) return null;
  const target = path.resolve(CRYPTO_DIR, "src", match[1]);
  if (fs.existsSync(target)) return target;
  if (fs.existsSync(`${target}.ts`)) return `${target}.ts`;
  return null;
}

function isCryptoPackageFile(file) {
  const normalized = file.replace(/\\/g, "/");
  if (CRYPTO_SRC && normalized.includes(CRYPTO_SRC)) return true;
  return normalized.includes("/node_modules/@sensors-social/crypto/");
}

function sensorsSocialCrypto() {
  return {
    name: "sensors-social-crypto",
    enforce: "pre",
    async resolveId(id, importer) {
      const cryptoFile = resolveCryptoSource(id);
      if (cryptoFile) return cryptoFile;
      if (!importer) return null;
      const from = importer.split("?")[0].replace(/\\/g, "/");
      if (!isCryptoPackageFile(from)) return null;
      if (id.startsWith("@noble/curves/")) {
        return this.resolve(`sensors-social-noble-curves${id.slice("@noble/curves".length)}`, importer, {
          skipSelf: true,
        });
      }
      if (id.startsWith("@noble/hashes/")) {
        return this.resolve(`sensors-social-noble-hashes${id.slice("@noble/hashes".length)}`, importer, {
          skipSelf: true,
        });
      }
      return null;
    },
    async transform(code, id) {
      const file = id.split("?")[0].replace(/\\/g, "/");
      if (!isCryptoPackageFile(file) || !file.endsWith(".ts")) return null;
      return transformWithEsbuild(code, id, {
        loader: "ts",
        format: "esm",
        tsconfigRaw: { compilerOptions: { target: "es2020" } },
      });
    },
  };
}

function getBlogRoutes() {
  const postsDir = path.resolve(__dirname, "src/blog")

  return fs
    .readdirSync(postsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => fs.existsSync(path.join(postsDir, entry.name, "index.md")))
    .map((entry) => `/blog/${entry.name}`)
}

export default defineConfig(() => {
  return {
    base: "/",
    // server: { https: true },
    plugins: [
      sensorsSocialCrypto(),
      vue({include: [/\.vue$/, /\.md$/]}),
      {
        name: "copy-blog-images",
        apply: "build",
        async writeBundle() {
          const blogDir = path.resolve(__dirname, "src/blog");
          const outDir = path.resolve(__dirname, "dist");

          const files = await fg(["**/images/**/*"], {
            cwd: blogDir,
            onlyFiles: true,
            dot: false,
            followSymbolicLinks: true,
          });

          await Promise.all(
            files.map(async (rel) => {
              const src = path.join(blogDir, rel);
              const dst = path.join(outDir, "blog", rel);
              await fsp.mkdir(path.dirname(dst), { recursive: true });
              await fsp.copyFile(src, dst);
            })
          );
        },
      },
      prerender({
        routes: [
          "/",
          "/privacy-policy",
          "/support",
          "/air-measurements",
          "/altruist-timeline",
          "/altruist-use-cases",
          "/altruist-compare",
          "/altruist-device-info",
          "/altruist-setup",
          "/where-to-buy",
          "/construction-monitoring",
          "/noise-data-real-estate",
          "/blog",
          // auto-generated blog routes
          ...getBlogRoutes()
        ],
        renderer: "@prerenderer/renderer-puppeteer",
      }),
        Markdown({
        frontmatter: true
      })
    ],
    resolve: {
      alias: [
        ...(CRYPTO_SRC_ALIAS
          ? [
              {
                find: /^@sensors-social\/crypto\/packages\/crypto\/src\/(.*)$/,
                replacement: `${CRYPTO_SRC_ALIAS}/$1`,
              },
              {
                find: /^@sensors-social\/crypto\/src\/(.*)$/,
                replacement: `${CRYPTO_SRC_ALIAS}/$1`,
              },
            ]
          : []),
        {
          find: /^@sensors-social\/crypto$/,
          replacement: fileURLToPath(new URL("./src/utils/sensorsSocialCrypto.js", import.meta.url)),
        },
        { find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) },
        { find: "@config", replacement: fileURLToPath(new URL("./src/config", import.meta.url)) },
      ],
    },
    build: {
      target: ["es2020"],
    },
    optimizeDeps: {
      esbuildOptions: {
        target: ["es2020"],
      },
      exclude: ["@sensors-social/crypto"],
      include: [
        "@bufbuild/protobuf",
        "@fortawesome/fontawesome-svg-core",
        "@fortawesome/free-brands-svg-icons",
        "@fortawesome/free-regular-svg-icons",
        "@fortawesome/free-solid-svg-icons",
        "@fortawesome/vue-fontawesome",
      ],
    },
  };
});
