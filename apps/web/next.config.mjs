import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
if (!process.env.FLIGHTBOT_DATA_DIR) {
  process.env.FLIGHTBOT_DATA_DIR = path.resolve(__dirname, "../..");
}

/** @type {import('next').NextConfig} */
const nextConfig = {};

export default nextConfig;
