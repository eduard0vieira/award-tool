import { formatDatesByMonth, type FormattedDay, type ReportSection } from "../../core/common.ts";

// TAP sells the economy-to-business miles upgrade at a fixed price per region.
// Only the advance upgrade between Brazil and mainland Portugal is known here
// (81,600 miles, per Eduardo): another region would put a made-up total in the alert.
const BRAZIL_PORTUGAL_UPGRADE_K = 81.6;
export const TAP_BRAZIL_AIRPORTS = new Set(["BEL", "BSB", "CNF", "FLN", "FOR", "GIG", "GRU", "MCZ", "NAT", "POA", "REC", "SSA", "VCP"]);
const MAINLAND_PORTUGAL_AIRPORTS = new Set(["LIS", "OPO", "FAO"]);

export function tapUpgradeCostK(origin: string, destination: string): number | null {
  const linked = (from: string, to: string) => TAP_BRAZIL_AIRPORTS.has(from) && MAINLAND_PORTUGAL_AIRPORTS.has(to);
  return linked(origin, destination) || linked(destination, origin) ? BRAZIL_PORTUGAL_UPGRADE_K : null;
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
