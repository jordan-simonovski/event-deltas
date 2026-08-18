import React, { ChangeEvent, useState } from 'react';
import { Button, Field, FieldSet, Input, useStyles2 } from '@grafana/ui';
import { AppPluginMeta, GrafanaTheme2, PluginConfigPageProps, PluginMeta } from '@grafana/data';
import { DataSourcePicker, getBackendSrv, locationService } from '@grafana/runtime';
import { css } from '@emotion/css';
import { lastValueFrom } from 'rxjs';
import {
  CLICKHOUSE_DS_TYPE,
  DEFAULT_DATASOURCE_UID,
  DEFAULT_TRACES_TABLE,
  EventDeltasJsonData,
} from '../../appConfig';

export interface AppConfigProps extends PluginConfigPageProps<AppPluginMeta<EventDeltasJsonData>> {}

const AppConfig = ({ plugin }: AppConfigProps) => {
  const s = useStyles2(getStyles);
  const { enabled, pinned, jsonData } = plugin.meta;

  const [datasourceUid, setDatasourceUid] = useState(jsonData?.datasourceUid ?? DEFAULT_DATASOURCE_UID);
  const [tracesTable, setTracesTable] = useState(jsonData?.tracesTable ?? DEFAULT_TRACES_TABLE);

  const onChangeTracesTable = (event: ChangeEvent<HTMLInputElement>) => {
    setTracesTable(event.target.value.trim());
  };

  const onSubmit = () => {
    updatePluginAndReload(plugin.meta.id, {
      enabled,
      pinned,
      jsonData: { datasourceUid, tracesTable },
    });
  };

  return (
    <div className={s.container}>
      <FieldSet label="Trace data">
        <Field
          label="Data source"
          description="The ClickHouse data source holding your OpenTelemetry spans."
        >
          <DataSourcePicker
            current={datasourceUid}
            filter={(ds) => ds.type === CLICKHOUSE_DS_TYPE}
            onChange={(ds) => setDatasourceUid(ds.uid)}
            width={40}
            noDefault
          />
        </Field>

        <Field
          label="Traces table"
          description="Table of OpenTelemetry spans, as written by the collector's ClickHouse exporter. Qualify it as database.table if the data source's default database is not the right one."
        >
          <Input
            width={40}
            value={tracesTable}
            placeholder={DEFAULT_TRACES_TABLE}
            onChange={onChangeTracesTable}
          />
        </Field>

        <Button type="submit" onClick={onSubmit} disabled={!datasourceUid || !tracesTable}>
          Save settings
        </Button>
      </FieldSet>
    </div>
  );
};

export default AppConfig;

const getStyles = (theme: GrafanaTheme2) => ({
  container: css({
    padding: theme.spacing(3),
    maxWidth: 640,
  }),
});

const updatePluginAndReload = async (
  pluginId: string,
  data: Partial<PluginMeta<EventDeltasJsonData>>
) => {
  try {
    await lastValueFrom(
      getBackendSrv().fetch({
        url: `/api/plugins/${pluginId}/settings`,
        method: 'POST',
        data,
      })
    );
    // Settings are read once when the app mounts, so the page has to come back
    // for a change to take effect.
    locationService.reload();
  } catch (e) {
    console.error('Error while updating the plugin', e);
  }
};
