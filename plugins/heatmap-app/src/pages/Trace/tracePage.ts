import { SceneAppPage } from '@grafana/scenes';
import { locationService } from '@grafana/runtime';
import { ROUTES } from '../../constants';
import { prefixRoute } from '../../utils/utils.routing';
import { traceScene } from './traceScene';
import { explorerPage } from '../Deltas/deltasPage';

function getTraceIdFromPathname(pathname: string): string {
  const parts = pathname.split('/').filter(Boolean);
  return decodeURIComponent(parts[parts.length - 1] ?? '');
}

export const tracePage = new SceneAppPage({
  title: 'Trace details',
  subTitle: 'Inspect representative outlier trace details to validate root cause.',
  url: prefixRoute(ROUTES.Trace),
  routePath: `${ROUTES.Trace}/:traceId`,
  getParentPage: () => explorerPage,
  getScene: () => {
    const pathname = locationService.getLocation().pathname ?? window.location.pathname;
    return traceScene(getTraceIdFromPathname(pathname));
  },
});
