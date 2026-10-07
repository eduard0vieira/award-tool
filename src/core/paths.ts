import path from "node:path";
import { fileURLToPath } from "node:url";

// Every disk path comes from here. Each file used to compute its own from
// `__dirname`, so moving a module silently moved its output folder: no compile
// error, no startup error, just a 404 or a file written to the wrong place.
export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const PUBLIC_DIR = path.join(ROOT_DIR, "public");
export const FIXTURES_DIR = path.join(ROOT_DIR, "fixtures");

// Generated outputs, kept out of git (see .gitignore).
export const ALERTS_DIR = path.join(ROOT_DIR, "alerts");
export const SPREADSHEETS_DIR = path.join(ROOT_DIR, "spreadsheets");
export const SESSION_SECRET_FILE = path.join(ROOT_DIR, ".session-secret");

// The alerts portal is another repository, a sibling of this one.
export const PORTAL_DIST_DIR = path.join(ROOT_DIR, "..", "vcc-alertas-portal", "dist");
