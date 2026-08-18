import {
  EmbeddedScene,
  SceneFlexItem,
  SceneFlexLayout,
  SceneQueryRunner,
  SceneTimeRange,
  VizPanel,
} from '@grafana/scenes';
import { escapeSql } from '@heatmap/shared-comparison';
import { getAppConfig } from '../../appConfig';
import { ErrorInsightsDrawer } from './ErrorInsightsDrawer';

function buildTraceWaterfallSql(traceId: string): string {
  const escapedTraceId = escapeSql(traceId);
  return `SELECT
    "TraceId" as traceID,
    "SpanId" as spanID,
    "ParentSpanId" as parentSpanID,
    "ServiceName" as serviceName,
    "SpanName" as operationName,
    multiply(toUnixTimestamp64Nano("Timestamp"), 0.000001) as startTime,
    multiply("Duration", 0.000001) as duration,
    arrayMap(key -> map('key', key, 'value', "SpanAttributes"[key]), mapKeys("SpanAttributes")) as tags,
    arrayMap(key -> map('key', key, 'value', "ResourceAttributes"[key]), mapKeys("ResourceAttributes")) as serviceTags,
    if("StatusCode" IN ('Error', 'STATUS_CODE_ERROR'), 2, 0) as statusCode,
    arrayMap(
      (name, timestamp, attributes) -> tuple(
        name,
        toString(toUnixTimestamp64Milli(timestamp)),
        arrayMap(key -> map('key', key, 'value', attributes[key]), mapKeys(attributes))
      )::Tuple(name String, timestamp String, fields Array(Map(String, String))),
      "Events".Name, "Events".Timestamp, "Events".Attributes
    ) AS logs,
    arrayMap(
      (linkedTraceId, linkedSpanId, attributes) -> tuple(
        linkedTraceId,
        linkedSpanId,
        arrayMap(key -> map('key', key, 'value', attributes[key]), mapKeys(attributes))
      )::Tuple(traceID String, spanID String, tags Array(Map(String, String))),
      "Links".TraceId, "Links".SpanId, "Links".Attributes
    ) AS references,
    "SpanKind" as kind,
    "StatusMessage" as statusMessage,
    "TraceState" as traceState
  FROM ${getAppConfig().tracesTable}
  WHERE traceID = '${escapedTraceId}'
  LIMIT 1000`;
}

function buildTraceSpansSql(traceId: string): string {
  const escapedTraceId = escapeSql(traceId);
  return `SELECT
    coalesce(
      nullIf(if(indexOf("Events".Name, 'exception') > 0, "Events".Attributes[indexOf("Events".Name, 'exception')]['exception.message'], ''), ''),
      nullIf("StatusMessage", ''),
      'unknown error'
    ) AS errorMessage,
    coalesce(
      nullIf(if(indexOf("Events".Name, 'exception') > 0, "Events".Attributes[indexOf("Events".Name, 'exception')]['exception.type'], ''), ''),
      'UnknownError'
    ) AS errorType,
    ServiceName AS dependentService,
    SpanName AS dependentCall,
    count() AS occurrences
  FROM ${getAppConfig().tracesTable}
  WHERE TraceId = '${escapedTraceId}'
    AND (StatusCode IN ('Error', 'STATUS_CODE_ERROR') OR indexOf("Events".Name, 'exception') > 0)
  GROUP BY errorMessage, errorType, dependentService, dependentCall
  ORDER BY occurrences DESC
  LIMIT 100`;
}

export function traceScene(traceId: string) {
  const waterfallQuery = new SceneQueryRunner({
    datasource: getAppConfig().datasource,
    queries: [
      {
        refId: 'trace',
        datasource: getAppConfig().datasource,
        queryType: 'sql',
        rawSql: buildTraceWaterfallSql(traceId),
        format: 1,
      } as any,
    ],
  });

  const spansQuery = new SceneQueryRunner({
    datasource: getAppConfig().datasource,
    queries: [
      {
        refId: 'spans',
        datasource: getAppConfig().datasource,
        rawSql: buildTraceSpansSql(traceId),
        format: 1,
        queryType: 'sql',
      },
    ],
  });

  return new EmbeddedScene({
    $timeRange: new SceneTimeRange({
      from: 'now-15m',
      to: 'now',
    }),
    body: new SceneFlexLayout({
      direction: 'column',
      children: [
        new SceneFlexItem({
          minHeight: 520,
          body: new VizPanel({
            title: 'Trace waterfall',
            pluginId: 'traces',
            $data: waterfallQuery,
            options: {},
          }),
        }),
        new SceneFlexItem({
          ySizing: 'content',
          body: new ErrorInsightsDrawer({
            expanded: false,
            $data: spansQuery,
            panel: new VizPanel({
              title: 'Error insights',
              pluginId: 'table',
              options: {
                showHeader: true,
              },
            }),
          }),
        }),
      ],
    }),
  });
}
