import { normalizeDomainList, isDomainBlocked } from './domain_filter.js';

// Request-local only: never read or update domain_filter's active blocklist.
function domains(value, name) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array of domain strings`);
  const normalized = [];
  for (const raw of value) {
    if (typeof raw !== 'string' || !raw.trim()) throw new TypeError(`${name} contains an invalid domain`);
    const items = normalizeDomainList([raw]);
    const domain = items[0];
    if (!domain || domain.length > 253 || !domain.split('.').every(label =>
      label.length >= 1 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
      throw new TypeError(`${name} contains an invalid domain: ${raw}`);
    }
    normalized.push(domain);
  }
  return [...new Set(normalized)].sort();
}

// Deliberately narrower than Date.parse: no local-time or rollover dates.
function dateMillis(value, name, endOfDay = false) {
  if (typeof value !== 'string') throw new TypeError(`${name} must be YYYY-MM-DD or an ISO timestamp with timezone`);
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2}))?$/.exec(value);
  if (!match) throw new TypeError(`${name} must be YYYY-MM-DD or an ISO timestamp with timezone`);
  const [, year, month, day, hour, minute, second, , zone] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (m < 1 || m > 12 || d < 1 || d > days[m - 1] ||
      (hour !== undefined && (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59)) ||
      (zone && zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59))) {
    throw new RangeError(`${name} is an impossible date`);
  }
  const millis = Date.parse(hour === undefined ? `${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z` : value);
  if (!Number.isFinite(millis)) throw new RangeError(`${name} is an invalid date`);
  return millis;
}

/**
 * Return a deeply frozen request-local value. Undefined fields mean absent;
 * other invalid values throw. Domain strings use normalizeDomainList semantics
 * (URL, port, www and trailing DNS dots), with strict DNS-label validation.
 * Effective excludeDomains contains globalBlocked too; exclusions always win.
 * Bounds are canonical ISO UTC strings, or null when absent; both inclusive.
 */
export function normalizeRequestFilters(input = {}, globalBlocked = []) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('request filters must be an object');
  }
  const includeDomains = domains(input.includeDomains, 'includeDomains');
  const excludeDomains = [...new Set([
    ...domains(input.excludeDomains, 'excludeDomains'), ...domains(globalBlocked, 'globalBlocked'),
  ])].sort();
  const after = input.publishedAfter === undefined ? null : dateMillis(input.publishedAfter, 'publishedAfter');
  const before = input.publishedBefore === undefined ? null : dateMillis(input.publishedBefore, 'publishedBefore', true);
  if (after !== null && before !== null && after > before) throw new RangeError('publishedAfter must not exceed publishedBefore');
  return Object.freeze({
    includeDomains: Object.freeze(includeDomains),
    excludeDomains: Object.freeze(excludeDomains),
    publishedAfter: after === null ? null : new Date(after).toISOString(),
    publishedBefore: before === null ? null : new Date(before).toISOString(),
  });
}

/** Test a source against a normalized value; publishedAt is the sole date field. */
export function sourceMatchesFilters(source, filters) {
  if (isDomainBlocked(source?.url, filters.excludeDomains)) return false;
  if (filters.includeDomains.length && !isDomainBlocked(source?.url, filters.includeDomains)) return false;
  if (filters.publishedAfter !== null || filters.publishedBefore !== null) {
    let published;
    try { published = dateMillis(source?.publishedAt, 'publishedAt'); } catch { return false; }
    if (filters.publishedAfter !== null && published < Date.parse(filters.publishedAfter)) return false;
    if (filters.publishedBefore !== null && published > Date.parse(filters.publishedBefore)) return false;
  }
  return true;
}

/** Preserve order, source identity, and the original array when nothing is removed. */
export function filterSources(sources, filters) {
  if (!Array.isArray(sources)) throw new TypeError('sources must be an array');
  const kept = sources.filter(source => sourceMatchesFilters(source, filters));
  return kept.length === sources.length ? sources : kept;
}

/** Stable JSON cache component for a normalized value, including global exclusions. */
export function requestFilterCacheKey(filters) {
  return JSON.stringify({
    includeDomains: [...filters.includeDomains].sort(),
    excludeDomains: [...filters.excludeDomains].sort(),
    publishedAfter: filters.publishedAfter,
    publishedBefore: filters.publishedBefore,
  });
}
