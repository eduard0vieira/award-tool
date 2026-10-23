import { formatDatesByMonth, type FormattedDay, type ReportSection } from "../../core/common.ts";

// TAP's advance upgrade from economy to business, in miles, from the table
// Eduardo sent on 2026-10-23: 81,600 for the crossing between Brazil and
// mainland Portugal, plus, on a connection, the leg from mainland Portugal by
// the region of the final destination. An airport outside the table has no
// price: a guessed one would put a made-up total in the alert.
const BRAZIL_PORTUGAL_UPGRADE_K = 81.6;
export const TAP_BRAZIL_AIRPORTS = new Set(["BEL", "BSB", "CNF", "FLN", "FOR", "GIG", "GRU", "MCZ", "NAT", "POA", "REC", "SSA", "VCP"]);
// TAP flies these from Brazil without a connection in Portugal.
const DIRECT_PORTUGAL_AIRPORTS = new Set(["LIS", "OPO"]);

const CONNECTION_REGIONS = [
  { label: "Portugal continental", costK: 11.9, airports: ["FAO"] },
  { label: "Madeira e Açores", costK: 14.4, airports: ["FNC", "PXO", "PDL", "TER", "HOR"] },
  {
    label: "Espanha e Norte de África",
    costK: 14.9,
    airports: ["MAD", "BCN", "AGP", "SVQ", "VLC", "BIO", "VGO", "OVD", "PMI", "IBZ", "LPA", "TFN", "TFS", "ACE", "CMN", "RAK", "TNG", "ALG", "TUN"],
  },
  {
    label: "Europa 1",
    costK: 18,
    airports: [
      "FRA", "MUC", "BER", "HAM", "DUS", "STR", "CGN", "BRU", "CDG", "ORY", "LYS", "NCE", "MRS", "TLS", "BOD", "NTE", "DUB",
      "FCO", "MXP", "LIN", "VCE", "BLQ", "NAP", "FLR", "TRN", "LUX", "AMS", "LHR", "LGW", "LCY", "MAN", "EDI", "ZRH", "GVA", "BSL",
    ],
  },
  { label: "Europa 2", costK: 22.8, airports: ["VIE", "CPH", "OSL", "WAW", "KRK", "PRG", "ARN", "GOT"] },
];

export type TapUpgradeCost = { costK: number; note: string };

const milesText = (costK: number) => Math.round(costK * 1000).toLocaleString("pt-BR");

export function tapUpgradeCost(origin: string, destination: string): TapUpgradeCost | null {
  const europe = TAP_BRAZIL_AIRPORTS.has(origin) ? destination : TAP_BRAZIL_AIRPORTS.has(destination) ? origin : null;
  if (europe === null) return null;
  const crossing = `${milesText(BRAZIL_PORTUGAL_UPGRADE_K)} milhas no trecho Brasil–Portugal continental`;
  if (DIRECT_PORTUGAL_AIRPORTS.has(europe)) return { costK: BRAZIL_PORTUGAL_UPGRADE_K, note: crossing };
  const region = CONNECTION_REGIONS.find((candidate) => candidate.airports.includes(europe));
  if (!region) return null;
  return {
    costK: Math.round((BRAZIL_PORTUGAL_UPGRADE_K + region.costK) * 10) / 10,
    note: `${crossing} + ${milesText(region.costK)} na conexão até ${europe}, ${region.label}`,
  };
}

export function tapUpgradeCostK(origin: string, destination: string): number | null {
  return tapUpgradeCost(origin, destination)?.costK ?? null;
}

export type TapUpgradeDay = FormattedDay & { economyK: number; businessK: number };
export type TapUpgradeSection = Omit<ReportSection, "days"> & { days: TapUpgradeDay[]; emptyReason?: string };

// Days with both cabins. With a known price the day is worth economy plus
// upgrade, and only when that beats the day's business fare; without one it
// shows the economy fare.
export function buildTapUpgradeSection(business: FormattedDay[], economy: FormattedDay[], costK: number | null): TapUpgradeSection {
  const economyByDate = new Map(economy.map((day) => [day.date, day.valueK]));
  const crossed = business.filter((day) => economyByDate.has(day.date));
  const days: TapUpgradeDay[] = crossed
    .map((day) => {
      const economyK = economyByDate.get(day.date)!;
      const valueK = costK === null ? economyK : Math.round((economyK + costK) * 10) / 10;
      return { date: day.date, valueK, economyK, businessK: day.valueK, ...(day.link && { link: day.link }) };
    })
    .filter((day) => costK === null || day.valueK < day.businessK)
    .sort((a, b) => a.date.localeCompare(b.date));

  if (days.length === 0) {
    return {
      min: null,
      max: null,
      days,
      text: "Nenhuma disponibilidade encontrada nesse período.",
      emptyReason:
        crossed.length === 0
          ? "Nenhum dia com Econômica e Executiva juntas nesse período."
          : "Nos dias com as duas cabines, a Executiva direta sai mais barata que Econômica + upgrade.",
    };
  }
  const values = days.map((day) => day.valueK);
  return { min: Math.min(...values), max: Math.max(...values), days, text: formatDatesByMonth(days.map((day) => day.date)) };
}
