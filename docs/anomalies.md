# Token anomaly detection

Deterministic, no AI. `detectAnomalies()` in `src/anomaly.ts`, exposed as `GET /api/anomalies` and as `anomalies` in `summary.json`.

## Rule

A series is one (project, agent) pair. It is flagged when, for the current local calendar day:

- its tokens so far are **>= 2.5 x** the baseline median, and
- its tokens so far are **>= 1,000,000**.

Both comparisons are inclusive (exactly 2.5x, or exactly 1,000,000, is flagged).

## Definitions

- **Tokens**: `input + output + cache_read + cache_write` of `assistant` events. `reasoning` (a subset of output) and
  `cache_write_1h` (a subset of cache writes) are not added again.
- **Day**: local calendar day (`date(ts/1000, 'unixepoch', 'localtime')`), the same as `daily7d` in the summary.
  The evaluated day is the local day of `now`; the response carries it as `day`, with `asOf` (epoch ms).
- **Future events** (`ts > now`) are ignored.
- **Baseline**: the 7 local days before the evaluated day. Only days with more than 0 tokens for that series are samples,
  so a day with no activity is *not* counted as zero. `baselineSamples` is the number of samples used.
- **Median**: sorted samples; the middle value for an odd count, the mean of the two middle values for an even count.
- **Sparse data**: fewer than **3** baseline samples means the series is never flagged, however large today is.
- **Partial day**: the evaluated day is incomplete (`partialDay: true`) while the baseline days are complete. This can only
  delay a flag until enough tokens have accumulated; it cannot create one.

## Output

```
{ day, asOf, partialDay, ratio: 2.5, minTokens: 1000000, baselineDays: 7, minBaselineSamples: 3,
  anomalies: [{ day, projectId, project, agent, tokens, baselineMedian, baselineSamples, ratio,
                topSessions: [{ sessionId, tokens, events, firstTs, lastTs }] }] }
```

`ratio` is `tokens / baselineMedian` rounded to 2 decimals. `topSessions` holds up to 3 sessions of that series with the most
tokens on the evaluated day (ties by session id). Only ids, counts, token totals and timestamps are returned; no prompt or
output text. Anomalies are sorted by tokens, largest first.

## API

`GET /api/anomalies` takes the usual `agent` and `project` (id) filters. `from` / `to` (epoch ms) clip the events considered
(so a `to` in the past usually yields no current-day tokens and no anomalies); the evaluated day stays the current local day.
The summary uses no filters.
