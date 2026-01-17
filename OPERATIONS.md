# Operations

## Live tail (prod)

```bash
npm run tail:prod
```

## Analytics Engine queries

Dataset: `proceedgate_metrics`

Field mapping:

- `index1=event`, `index2=policy_id`, `index3=action`, `index4=detail`
- `double1=1` (counter), `double2=latency_ms`

Example queries:

- Recent datapoints:
  - `SELECT * FROM proceedgate_metrics ORDER BY timestamp DESC LIMIT 50;`
- Counts by event (last hour):
  - `SELECT index1 AS event, SUM(double1) AS cnt FROM proceedgate_metrics WHERE timestamp > NOW() - INTERVAL '1' HOUR GROUP BY event ORDER BY cnt DESC;`
- Latency avg/p95 (last hour):
  - `SELECT index1 AS event, AVG(double2) AS avg_ms, PERCENTILE(double2, 0.95) AS p95_ms FROM proceedgate_metrics WHERE timestamp > NOW() - INTERVAL '1' HOUR GROUP BY event ORDER BY avg_ms DESC;`
