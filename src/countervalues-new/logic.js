// @flow

import { log } from "@ledgerhq/logs";
import { getEnv } from "../env";
import type { Currency, Account } from "../types";
import { flattenAccounts } from "../account";
import { getAccountCurrency } from "../account";
import { promiseAllBatched } from "../promise";
import type {
  CounterValuesState,
  CountervaluesSettings,
  TrackingPair,
  RateMap,
  RateGranularity,
  PairRateMapCache,
} from "./types";
import api from "./api";
import {
  magFromTo,
  formatPerGranularity,
  formatCounterValueDay,
  formatCounterValueHour,
} from "./helpers";

const granularityConfig: {
  [g: RateGranularity]: { minDateDelta?: number, maxDateDelta?: number },
} = {
  daily: {
    maxDateDelta: 9999 * 24 * 60 * 60 * 1000,
  },
  hourly: {
    // we fetch at MOST a week of hourly. after that there are too much data...
    maxDateDelta: 7 * 24 * 60 * 60 * 1000,
  },
};

// TODO
// export/import functions... they would use generateCache
// TODO: implementation special logic for WETH=ETH

export const initialState = {
  data: {},
  stats: {},
  cache: {},
};

const DAY = 24 * 60 * 60 * 1000;

function generateCache(
  pair: string,
  rateMap: RateMap,
  settings: CountervaluesSettings
): PairRateMapCache {
  const map = { ...rateMap };

  const sorted = Object.keys(map)
    .sort()
    .filter((k) => k !== "latest");
  const oldestDate = sorted[0];
  const newestDate = sorted[sorted.length - 1];
  let fallback;

  if (settings.autofillGaps) {
    if (oldestDate) {
      const now = Date.now();
      const oldestTime = new Date(oldestDate).getTime();
      let shiftingValue = map[oldestDate];
      fallback = shiftingValue;
      for (let t = oldestTime; t < now; t += DAY) {
        const k = formatCounterValueDay(new Date(t));
        if (!(k in map)) {
          map[k] = shiftingValue;
        } else {
          shiftingValue = map[k];
        }
      }
      if (!map.latest) {
        map.latest = shiftingValue;
      }
    } else {
      fallback = map.latest || 0;
    }
  }

  return { map, newestDate, oldestDate, fallback };
}

export async function loadCountervalues(
  state: CounterValuesState,
  settings: CountervaluesSettings
): Promise<CounterValuesState> {
  const stats = { ...state.stats };
  const data = { ...state.data };
  const cache = { ...state.cache };

  const histoToFetch = [];
  const latestToFetch = settings.trackingPairs;

  (!getEnv("EXPERIMENTAL_PORTFOLIO_RANGE")
    ? ["daily"]
    : ["daily", "hourly"]
  ).forEach((granularity) => {
    const nowDate = new Date();
    const format = formatPerGranularity[granularity];
    const now = format(nowDate);
    const config = granularityConfig[granularity];
    settings.trackingPairs.forEach(({ from, to, startDate }) => {
      let start = startDate || nowDate;
      const minDate =
        config.minDateDelta && Date.now() - (config.minDateDelta || 0);
      if (minDate && minDate < start) {
        start = new Date(minDate);
      }
      const maxDate =
        config.maxDateDelta && Date.now() - (config.maxDateDelta || 0);
      if (maxDate && start < maxDate) {
        start = new Date(maxDate);
      }
      const key = `${from}-${to}`;
      const value = data[key];
      const inSync = value && value[now]; // TODO also make sure there is not an older date than requested before.
      const stat = stats[key];
      const needOlderReload =
        stat && start < new Date(stat.oldestDateRequested);
      if (inSync && !needOlderReload) {
        return;
      }

      // nothing to fetch for historical
      if (format(start) === now) return;

      // FIXME this all shall be set if it SUCCESS.
      stats[key] = {
        ...stat,
        oldestDateRequested: start.toISOString(),
      };
      // TODO we can update pair.start with latest date we got for that granularity.
      histoToFetch.push([granularity, { from, to, startDate: start }, key]);
    });
  });

  const [histo, latest] = await Promise.all([
    promiseAllBatched(5, histoToFetch, ([granularity, pair, key]) =>
      api
        .fetchHistorical(granularity, pair)
        .then((rates) => ({ [key]: rates }))
        .catch((e) => {
          log(
            "countervalues-error",
            `Failed to fetch ${granularity} history for ${pair.from}-${
              pair.to
            } ${String(e)}`
          );
          return {};
        })
    ),
    api
      .fetchLatest(latestToFetch)
      .then((rates) => {
        const out = {};
        latestToFetch.forEach(({ from, to }, i) => {
          out[`${from}-${to}`] = { latest: rates[i] };
        });
        return out;
      })
      .catch((e) => {
        log(
          "countervalues-error",
          "Failed to fetch latest for " +
            latestToFetch.map((p) => `${p.from}-${p.to}`).join(",") +
            " " +
            String(e)
        );
        return {};
      }),
  ]);

  const updates = histo.concat(latest);

  const changesKeys = {};
  updates.forEach((patch) => {
    Object.keys(patch).forEach((key) => {
      changesKeys[key] = 1;
      data[key] = { ...data[key], ...patch[key] };
    });
  });

  // synchronize the cache
  Object.keys(changesKeys).forEach((pair) => {
    cache[pair] = generateCache(pair, data[pair], settings);
  });

  return { data, cache, stats };
}

export function inferTrackingPairForAccounts(
  accounts: Account[],
  countervalue: Currency
): TrackingPair[] {
  if (countervalue.disableCountervalue) return [];
  const d: { [_: string]: TrackingPair } = {};
  flattenAccounts(accounts).forEach((a) => {
    const currency = getAccountCurrency(a);
    if (currency.disableCountervalue) return;
    let date = a.creationDate.getTime();
    if (d[currency.id]) {
      const { startDate } = d[currency.id];
      if (startDate) {
        date = Math.min(date, startDate.getTime());
      }
    }
    d[currency.id] = {
      from: currency.ticker,
      to: countervalue.ticker,
      startDate: new Date(date),
    };
  });
  // $FlowFixMe -_-
  return Object.values(d);
}

export function lenseRateMap(
  state: CounterValuesState,
  { from, to }: { from: Currency, to: Currency }
): ?PairRateMapCache {
  if (to.disableCountervalue || from.disableCountervalue) return;
  const rateId = `${from.ticker}-${to.ticker}`;
  return state.cache[rateId];
}

export function lenseRate(
  { newestDate, fallback, map }: PairRateMapCache,
  query: {
    from: Currency,
    to: Currency,
    date?: ?Date,
  }
): ?number {
  const { date } = query;
  if (!date) return map.latest;
  const hourFormat = formatCounterValueHour(date);
  if (hourFormat in map) return map[hourFormat];
  const dayFormat = formatCounterValueDay(date);
  if (dayFormat in map) return map[dayFormat];
  if (dayFormat > newestDate) return map.latest;
  return fallback;
}

export function calculate(
  state: CounterValuesState,
  query: {
    value: number,
    from: Currency,
    to: Currency,
    disableRounding?: boolean,
    date?: ?Date,
  }
): ?number {
  const map = lenseRateMap(state, query);
  if (!map) return;
  const rate = lenseRate(map, query);
  if (!rate) return;
  const { value, from, to, disableRounding } = query;
  const val = value * rate * magFromTo(from, to);
  return disableRounding ? val : Math.round(val);
}

export function calculateMany(
  state: CounterValuesState,
  dataPoints: Array<{ value: number, date: ?Date }>,
  query: { from: Currency, to: Currency }
): Array<?number> {
  const map = lenseRateMap(state, query);
  if (!map) return Array(dataPoints.length).fill(); // undefined array
  const { from, to } = query;
  const mag = magFromTo(from, to);
  return dataPoints.map(({ value, date }) => {
    const rate = lenseRate(map, { from, to, date });
    if (!rate) return;
    const val = value * rate * mag;
    return Math.round(val);
  });
}
