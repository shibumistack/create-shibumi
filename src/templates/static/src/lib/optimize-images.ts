/**
 * Image optimization using Bun's built-in Image API.
 *
 * Scans a directory for images, optimizes them, and outputs WebP versions.
 * Zero dependencies: just Bun.
 *
 * Usage:
 *   bun run src/lib/optimize-images.ts [input-dir] [output-dir]
 *
 * Defaults:
 *   input:  public/images
 *   output: public/images/optimized
 */

const INPUT_DIR = process.argv[2] || "public/images";
const OUTPUT_DIR = process.argv[3] || "public/images/optimized";

const { Image } = Bun;
const { readdirSync, mkdirSync, existsSync } = require("fs");
const { join, extname } = require("path");

const SUPPORTED = new Set([".png", ".jpg", ".jpeg", ".webp", ".avif"]);

interface Stats {
  files: number;
  originalSize: number;
  optimizedSize: number;
}

async function optimizeImage(inputPath: string, outputPath: string): Promise<number> {
  const img = new Image(inputPath);
  const meta = await img.metadata();

  // Convert to WebP (best compression for web)
  const webpBuf = await img.bytes("webp", { quality: 80 });

  // Write optimized file
  await Bun.write(outputPath, webpBuf);

  return webpBuf.length;
}

async function optimizeDirectory(inputDir: string, outputDir: string): Promise<Stats> {
  const stats: Stats = { files: 0, originalSize: 0, optimizedSize: 0 };

  if (!existsSync(inputDir)) {
    console.log(`  Input directory not found: ${inputDir}`);
    return stats;
  }

  mkdirSync(outputDir, { recursive: true });

  const entries = readdirSync(inputDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      // Recurse into subdirectories
      const subStats = await optimizeDirectory(
        join(inputDir, entry.name),
        join(outputDir, entry.name)
      );
      stats.files += subStats.files;
      stats.originalSize += subStats.originalSize;
      stats.optimizedSize += subStats.optimizedSize;
      continue;
    }

    const ext = extname(entry.name).toLowerCase();
    if (!SUPPORTED.has(ext)) continue;

    const inputPath = join(inputDir, entry.name);
    const outputName = entry.name.replace(ext, ".webp");
    const outputPath = join(outputDir, outputName);

    try {
      const originalBuf = Bun.file(inputPath);
      const originalSize = originalBuf.size;

      const optimizedSize = await optimizeImage(inputPath, outputPath);

      stats.files++;
      stats.originalSize += originalSize;
      stats.optimizedSize += optimizedSize;

      const savings = ((1 - optimizedSize / originalSize) * 100).toFixed(1);
      console.log(`  ✓ ${entry.name} → ${outputName} (${savings}% smaller)`);
    } catch (err: any) {
      console.log(`  ✗ ${entry.name}: ${err.message}`);
    }
  }

  return stats;
}

async function main() {
  console.log(`\n  Optimizing images from ${INPUT_DIR}\n`);

  const stats = await optimizeDirectory(INPUT_DIR, OUTPUT_DIR);

  if (stats.files === 0) {
    console.log("  No images found.\n");
    return;
  }

  const savings = ((1 - stats.optimizedSize / stats.originalSize) * 100).toFixed(1);
  const originalKB = (stats.originalSize / 1024).toFixed(1);
  const optimizedKB = (stats.optimizedSize / 1024).toFixed(1);

  console.log(`\n  ${stats.files} images optimized`);
  console.log(`  ${originalKB}KB → ${optimizedKB}KB (${savings}% smaller)\n`);
}

main();
