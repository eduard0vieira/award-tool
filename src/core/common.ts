export type OnLog = (message: string) => void;
export type OnProgress = (fraction: number) => void;
export type OnWindow = (info: { current: number; total: number; start: string; end: string }) => void;
// Transient notices (e.g. "waiting N min for a rate-limit block") worth showing
// even though they are neither an error nor progress.
export type OnNotice = (message: string) => void;

// Checked at each sweep's safe points (between windows, between months). True
// means the search was stopped from the screen: return what already came in
// instead of spending queries on a source nobody is waiting for.
export type ShouldStop = () => boolean;

export type FormattedDay = {
  date: string; // YYYY-MM-DD
  valueK: number;
  // Booking deep link for that day, when the source can build one. Never part of
  // the copied `text`: the group receives dates, not URLs.
  link?: string;
};

export type ReportSection = {
  min: number | null;
  max: number | null;
  days: FormattedDay[]; // chronological
  text: string; // "Mmm YYYY: DD, DD, ..." (for copying)
  // How the front formats min/max and the values. Absent means "K" (thousands of
  // miles); LATAM uses "BRL" because it works with fares in reais.
  unit?: "K" | "BRL";
};

export type LabeledSection<Day = FormattedDay> = Omit<ReportSection, "days"> & {
  label: string;
  colorClass?: string;
  days: Day[];
};

export const MONTHS_PT = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];

export function parseValueK(value: string): number | null {
  if (!value || value === "-") return null;
  const number = parseFloat(value.replace(/K$/i, "").replace(",", "."));
  return Number.isNaN(number) ? null : number;
}

// `suffixOf` appends something to each day; SeatSpy uses it for seats, giving
// "Mai 2026: 01 (2), 05 (4)". This is the format the alert generator already
// parses when pasted (parseDates in vcc-alertas-portal).
export function formatDatesByMonth(dates: string[], suffixOf?: (date: string) => string): string {
  const groups = new Map<string, string[]>();
  for (const date of dates) {
    const [year, month, day] = date.split("-") as [string, string, string];
    const key = `${year}-${month}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(`${day}${suffixOf ? suffixOf(date) : ""}`);
  }
  return Array.from(groups.keys())
    .sort()
    .map((key) => {
      const [year, month] = key.split("-") as [string, string];
      return `${MONTHS_PT[parseInt(month, 10) - 1]} ${year}: ${groups.get(key)!.join(", ")}`;
    })
    .join("\n");
}

// Search sites block "too frequent" searches on the same account or IP (it
// happened with AwardTool in agents mode). This spaces the START of each search,
// even across pool sessions, because the limit is per account, not per session.
// Each source has its own instance with its own interval.
export class RateLimiter {
  private nextSlot = 0;

  constructor(private minIntervalMs: number) {}

  async waitTurn(): Promise<void> {
    const now = Date.now();
    const wait = Math.max(0, this.nextSlot - now);
    this.nextSlot = Math.max(now, this.nextSlot) + this.minIntervalMs;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }
}
