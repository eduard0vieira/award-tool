import path from "node:path";
import { fileURLToPath } from "node:url";

// Todo caminho de disco do projeto sai daqui.
//
// Antes cada arquivo calculava o seu com `__dirname`, o que amarrava a pasta
// onde ele estava: mover um módulo quebrava silenciosamente a pasta de saída
// dele — sem erro de compilação, sem erro na subida, só um 404 ou um arquivo
// gravado no lugar errado. Com uma raiz só, mover arquivo deixa de mexer em
// caminho.
export const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const DIR_PUBLICO = path.join(RAIZ, "public");
export const DIR_FIXTURES = path.join(RAIZ, "fixtures");
export const DIR_CONTEXTO = path.join(RAIZ, "contexto");

// Saídas geradas (ficam fora do git — ver .gitignore).
export const DIR_ALERTAS_GERADOS = path.join(RAIZ, "alertas");
export const DIR_PLANILHAS = path.join(RAIZ, "planilhas");

// O portal de alertas é outro repositório, irmão deste.
export const DIR_PORTAL_DIST = path.join(RAIZ, "..", "vcc-alertas-portal", "dist");
