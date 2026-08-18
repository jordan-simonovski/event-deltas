import pluginJson from './plugin.json';

export const PLUGIN_BASE_URL = `/a/${pluginJson.id}`;

export enum ROUTES {
  Investigations = 'investigations',
  Catalog = 'catalog',
  Ownership = 'ownership',
  Operations = 'operations',
  Team = 'team/:id',
  Service = 'service/:id',
  Detail = 'slo/:id',
}

export const routeFor = {
  team: (teamId: string) => `team/${teamId}`,
  service: (serviceId: string) => `service/${serviceId}`,
  slo: (sloId: string) => `slo/${sloId}`,
};

export const EVENT_DELTAS_APP_ID = 'jordo-event-deltas-app';

export const CLICKHOUSE_DS = {
  uid: 'clickhouse',
  type: 'grafana-clickhouse-datasource',
};

