/**
 * Minimal in-process metrics registry exposed as Prometheus text at /metrics.
 * Deliberately dependency-free; swap for prom-client/OpenTelemetry in production if preferred.
 */
type Labels = Record<string, string>;
const key = (name: string, labels: Labels) =>
  name + (Object.keys(labels).length ? '{' + Object.entries(labels).sort().map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`).join(',') + '}' : '');

class Counter {
  private values = new Map<string, number>();
  constructor(public name: string, public help: string) {}
  inc(labels: Labels = {}, by = 1) { const k = key(this.name, labels); this.values.set(k, (this.values.get(k) ?? 0) + by); }
  render() { return [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`, ...[...this.values].map(([k, v]) => `${k} ${v}`)].join('\n'); }
}
class Gauge {
  private values = new Map<string, number>();
  constructor(public name: string, public help: string) {}
  set(value: number, labels: Labels = {}) { this.values.set(key(this.name, labels), value); }
  render() { return [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`, ...[...this.values].map(([k, v]) => `${k} ${v}`)].join('\n'); }
}
class Histogram {
  private sums = new Map<string, number>(); private counts = new Map<string, number>();
  private buckets = new Map<string, number[]>();
  constructor(public name: string, public help: string, private bounds = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000]) {}
  observe(value: number, labels: Labels = {}) {
    const k = key(this.name, labels);
    this.sums.set(k, (this.sums.get(k) ?? 0) + value); this.counts.set(k, (this.counts.get(k) ?? 0) + 1);
    const b = this.buckets.get(k) ?? new Array(this.bounds.length).fill(0);
    this.bounds.forEach((bound, i) => { if (value <= bound) b[i]++; });
    this.buckets.set(k, b);
  }
  render() {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [k, b] of this.buckets) {
      const base = k.includes('{') ? k.slice(0, -1) + ',' : k + '{';
      this.bounds.forEach((bound, i) => lines.push(`${this.name}_bucket${base.slice(this.name.length)}le="${bound}"} ${b[i]}`));
      lines.push(`${this.name}_bucket${base.slice(this.name.length)}le="+Inf"} ${this.counts.get(k)}`);
      lines.push(`${this.name}_sum${k.slice(this.name.length)} ${this.sums.get(k)}`);
      lines.push(`${this.name}_count${k.slice(this.name.length)} ${this.counts.get(k)}`);
    }
    return lines.join('\n');
  }
}

export const metrics = {
  jobsProcessed: new Counter('aap_jobs_processed_total', 'Queue jobs processed'),
  jobsFailed: new Counter('aap_jobs_failed_total', 'Queue jobs failed'),
  eventsIngested: new Counter('aap_events_ingested_total', 'Customer events accepted'),
  eventsDuplicate: new Counter('aap_events_duplicate_total', 'Customer events rejected as duplicates'),
  eventsProcessed: new Counter('aap_events_processed_total', 'Customer events applied'),
  membershipTransitions: new Counter('aap_membership_transitions_total', 'Audience ENTER/EXIT transitions'),
  syncMembers: new Counter('aap_sync_members_total', 'Members sent to destinations by op and result'),
  destinationRequests: new Counter('aap_destination_requests_total', 'Destination API requests by type/status'),
  destinationLatency: new Histogram('aap_destination_request_ms', 'Destination API latency (ms)'),
  apiLatency: new Histogram('aap_api_request_ms', 'API request latency (ms)'),
  queueDepth: new Gauge('aap_queue_depth', 'Pending jobs per queue'),
  dbPool: new Gauge('aap_db_pool', 'DB pool stats'),
  render(): string {
    return [this.jobsProcessed, this.jobsFailed, this.eventsIngested, this.eventsDuplicate, this.eventsProcessed,
      this.membershipTransitions, this.syncMembers, this.destinationRequests, this.destinationLatency, this.apiLatency,
      this.queueDepth, this.dbPool].map((m) => m.render()).join('\n') + '\n';
  },
};
