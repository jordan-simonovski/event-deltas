/**
 * Where the app reads its telemetry from.
 *
 * Resolved once when the app root mounts and read by the scenes as they build.
 * Grafana reloads the page when plugin settings are saved, so this never has to
 * change under a live scene.
 */

export interface EventDeltasJsonData {
  /** UID of the ClickHouse data source holding the traces. */
  datasourceUid?: string;
  /** Table holding OpenTelemetry spans. Qualify it (`db.table`) if the data source's default database is not the right one. */
  tracesTable?: string;
}

export const CLICKHOUSE_DS_TYPE = 'grafana-clickhouse-datasource';
export const DEFAULT_DATASOURCE_UID = 'clickhouse';
export const DEFAULT_TRACES_TABLE = 'otel_traces';

export interface ResolvedAppConfig {
  datasource: { uid: string; type: string };
  tracesTable: string;
}

export function resolveAppConfig(jsonData?: EventDeltasJsonData): ResolvedAppConfig {
  return {
    datasource: {
      uid: jsonData?.datasourceUid?.trim() || DEFAULT_DATASOURCE_UID,
      type: CLICKHOUSE_DS_TYPE,
    },
    tracesTable: jsonData?.tracesTable?.trim() || DEFAULT_TRACES_TABLE,
  };
}

let current: ResolvedAppConfig = resolveAppConfig();

export function setAppConfig(jsonData?: EventDeltasJsonData): void {
  current = resolveAppConfig(jsonData);
}

export function getAppConfig(): ResolvedAppConfig {
  return current;
}
