// Jest globals imported explicitly: @types/jest is hoisted to repo-root node_modules,
// outside the scaffold's typeRoots, so tsc can't see ambient describe/it/expect.
import { describe, expect, it } from '@jest/globals';
import {
  CLICKHOUSE_DS_TYPE,
  DEFAULT_DATASOURCE_UID,
  DEFAULT_TRACES_TABLE,
  getAppConfig,
  resolveAppConfig,
  setAppConfig,
} from './appConfig';

describe('resolveAppConfig', () => {
  it('falls back to the demo stack defaults when nothing is configured', () => {
    expect(resolveAppConfig()).toEqual({
      datasource: { uid: DEFAULT_DATASOURCE_UID, type: CLICKHOUSE_DS_TYPE },
      tracesTable: DEFAULT_TRACES_TABLE,
    });
  });

  it('uses the configured data source and table', () => {
    expect(resolveAppConfig({ datasourceUid: 'ch-prod', tracesTable: 'otel.spans' })).toEqual({
      datasource: { uid: 'ch-prod', type: CLICKHOUSE_DS_TYPE },
      tracesTable: 'otel.spans',
    });
  });

  it('treats blank and whitespace-only settings as unset', () => {
    const config = resolveAppConfig({ datasourceUid: '   ', tracesTable: '' });

    expect(config.datasource.uid).toBe(DEFAULT_DATASOURCE_UID);
    expect(config.tracesTable).toBe(DEFAULT_TRACES_TABLE);
  });

  it('trims surrounding whitespace rather than baking it into SQL', () => {
    expect(resolveAppConfig({ tracesTable: '  spans  ' }).tracesTable).toBe('spans');
  });
});

describe('setAppConfig', () => {
  it('is what the scenes read afterwards', () => {
    setAppConfig({ datasourceUid: 'ch-eu', tracesTable: 'spans' });

    expect(getAppConfig()).toEqual({
      datasource: { uid: 'ch-eu', type: CLICKHOUSE_DS_TYPE },
      tracesTable: 'spans',
    });

    setAppConfig(undefined);
    expect(getAppConfig().datasource.uid).toBe(DEFAULT_DATASOURCE_UID);
  });
});
