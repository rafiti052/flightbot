export interface Route {
  name: string;
  from: string;
  to: string;
  roundTrip: boolean;
  departureDate: string;
  returnDate?: string | null;
  flexDays?: number | null;
  currency?: string | null;
  maxStops?: number | null;
  maxBudget?: number | null;
  maxDurationHours?: number | null;
  active: boolean;
  _dateLabel?: string;
}

export interface ConfigFile {
  schedule: string;
  routes: Route[];
  anthropic?: {
    apiKey?: string;
  };
  telegram?: {
    token?: string;
    chatId?: string;
  };
}

export interface RuntimeConfig extends ConfigFile {
  anthropic: {
    apiKey: string;
  };
  telegram: {
    token: string;
    chatId: string;
  };
}

export interface Flight {
  price: number | null;
  airline: string | null;
  duration: string | null;
  stops: number | null;
  depTime: string | null;
  arrTime: string | null;
  _variant?: Route;
}

export interface FlightExtractionResult {
  flights: Flight[];
  rawText: string;
  parseError: Error | null;
}

export interface FilterOptions {
  maxStops?: number | null;
  maxDurationHours?: number | null;
  maxBudget?: number | null;
}

export interface PriceState {
  lastAlertPrice?: number;
  lastAlertAt?: string;
  lastSeenPrice?: number;
  lastSeenAt?: string;
}

export type PricesFile = Record<string, PriceState>;

export type AlertType = "first" | "lower" | "returned";

export interface RunOutcome {
  route: Route;
  best: number | null;
  budget: number | null;
  alertType: AlertType | null;
  prevPrice: number | null;
  error: unknown | null;
}
