import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mirrorCaption } from "./alerts.ts";

describe("return caption", () => {
  // The outbound caption exactly as the portal's ?render page wrote it.
  const outbound = [
    "✈️ *São Paulo (GRU) 🇧🇷 - Madrid (MAD)* 🇪🇸",
    "🚨 *Classe Econômica Iberia*",
    "",
    "🌎 Programa de milhas: Iberia Club",
    "🛫 20.000 a 24.250 Avios por pessoa + taxas",
  ].join("\n");

  test("mirrors only the route line, keeping the bold before the last flag", () => {
    assert.equal(
      mirrorCaption(outbound),
      [
        "✈️ *Madrid (MAD) 🇪🇸 - São Paulo (GRU)* 🇧🇷",
        "🚨 *Classe Econômica Iberia*",
        "",
        "🌎 Programa de milhas: Iberia Club",
        "🛫 20.000 a 24.250 Avios por pessoa + taxas",
      ].join("\n"),
    );
  });

  test("keeps city names that contain spaces and hyphens", () => {
    const caption = "✈️ *Rio de Janeiro (GIG) 🇧🇷 - Saint-Denis (RUN)* 🇷🇪\n🚨 *Classe Executiva Air France*";
    assert.equal(mirrorCaption(caption).split("\n")[0], "✈️ *Saint-Denis (RUN) 🇷🇪 - Rio de Janeiro (GIG)* 🇧🇷");
  });

  test("refuses a route line it does not recognize instead of guessing", () => {
    assert.throws(() => mirrorCaption("GRU - MAD\n🚨 *Classe Econômica Iberia*"), /mudou de formato/);
  });
});
