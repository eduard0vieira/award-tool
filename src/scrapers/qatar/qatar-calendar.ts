import { formatDatesByMonth, type ReportSection } from "../../core/common.ts";

export type QatarCabin = "ECONOMY";

// The calendar flags its two named fare bands; a priced day with neither flag
// (60K on GRU→NRT, 57K on GRU→BKK) is a third band the site leaves unnamed.
export type QatarFareBand = "offpeak" | "flexi" | "privilege_pick" | null;

export type QatarDay = { date: string; avios: number; band: QatarFareBand };

export type QatarRoute = { origin: string; destination: string };

type RawCalendarDay = Record<string, unknown>;

function requiredBoolean(day: RawCalendarDay, field: string, date: string): boolean {
  const value = day[field];
  if (typeof value !== "boolean") throw new Error(`Calendário da Qatar sem o campo "${field}" no dia ${date}.`);
  return value;
}

function bandOf(day: RawCalendarDay, date: string): QatarFareBand {
  const flags = (
    [
      ["offPeakIndicator", "offpeak"],
      ["flexiIndicator", "flexi"],
      ["privilegePickIndicator", "privilege_pick"],
    ] as const
  ).filter(([field]) => requiredBoolean(day, field, date));
  if (flags.length > 1) throw new Error(`Calendário da Qatar marcou mais de uma faixa de tarifa no dia ${date}.`);
  return flags[0]?.[1] ?? null;
}

// A day without `lowestPrice` is a day with no award seat. A priced day must
// say it is in Avios and in the cabin asked for: anything else is not this calendar.
export function readCalendar(text: string, cabin: QatarCabin): QatarDay[] {
  const parsed = JSON.parse(text) as { faresFromCalendar?: unknown };
  if (!Array.isArray(parsed.faresFromCalendar)) {
    throw new Error('Resposta do calendário da Qatar sem o campo "faresFromCalendar".');
  }

  const days: QatarDay[] = [];
  for (const raw of parsed.faresFromCalendar as RawCalendarDay[]) {
    const date = raw.date;
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error('Calendário da Qatar com um dia sem o campo "date".');
    }
    const band = bandOf(raw, date);
    if (raw.lowestPrice === undefined) continue;

    if (typeof raw.lowestPrice !== "number" || raw.lowestPrice <= 0) {
      throw new Error(`Calendário da Qatar com "lowestPrice" inválido no dia ${date}: ${String(raw.lowestPrice)}.`);
    }
    if (raw.currencyCode !== "AVIOS") {
      throw new Error(`Calendário da Qatar com preço em "${String(raw.currencyCode)}", não em Avios, no dia ${date}.`);
    }
    if (raw.cabinClass !== cabin) {
      throw new Error(`Calendário da Qatar respondeu a cabine "${String(raw.cabinClass)}" em vez de ${cabin} no dia ${date}.`);
    }
    days.push({ date, avios: raw.lowestPrice, band });
  }
  return days;
}

export function qatarCalendarLink(route: QatarRoute, date: string): string {
  const query = new URLSearchParams({
    widget: "QR",
    searchType: "F",
    addTaxToFare: "Y",
    minPurTime: "0",
    selLang: "pt",
    tripType: "O",
    fromStation: route.origin,
    toStation: route.destination,
    departing: date,
    bookingClass: "E",
    adults: "1",
    children: "0",
    infants: "0",
    ofw: "0",
    teenager: "0",
    flexibleDate: "off",
    qmilesFlow: "true",
    allowRedemption: "Y",
  });
  return `https://www.qatarairways.com/app/booking/award-calendar?${query}`;
}

// The ceiling is in absolute Avios (70000); pricier days are left out.
export function buildQatarReport(days: QatarDay[], ceilingAvios: number | null, route?: QatarRoute): ReportSection {
  const accepted = days.filter((day) => ceilingAvios == null || day.avios <= ceilingAvios);
  if (accepted.length === 0) {
    return { min: null, max: null, days: [], text: "Nenhuma disponibilidade encontrada nesse período." };
  }

  const formattedDays = accepted.map((day) => ({
    date: day.date,
    valueK: Math.round(day.avios / 10) / 100,
    ...(route ? { link: qatarCalendarLink(route, day.date) } : {}),
  }));
  const values = formattedDays.map((day) => day.valueK);
  return {
    min: Math.min(...values),
    max: Math.max(...values),
    days: formattedDays,
    text: formatDatesByMonth(formattedDays.map((day) => day.date)),
  };
}
