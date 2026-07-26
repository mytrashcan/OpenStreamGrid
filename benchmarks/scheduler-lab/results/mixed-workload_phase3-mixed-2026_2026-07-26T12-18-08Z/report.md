# Scheduler lab: mixed-workload

- Seed: `phase3-mixed-2026`
- Requests per policy: 400
- Generated: 2026-07-26T12:18:08.185Z

| Policy | Deadline met | Peer wins | Origin wins | Hedges started | Completion p50 | Completion p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Node-legacy | 85% | 77.5% | 22.5% | 0% | 860.54 ms | 1365.967 ms |
| Node-deadline-aware | 100% | 63.75% | 36.25% | 6.75% | 769.12 ms | 1332.578 ms |
| Browser-legacy | 84.5% | 98.75% | 1.25% | 0% | 801.724 ms | 1271.02 ms |
| Browser-deadline-aware | 100% | 81.5% | 18.5% | 0.75% | 722.175 ms | 1265.833 ms |

_Controlled deterministic scheduler simulation using production schedulers. Not a production capacity claim._
