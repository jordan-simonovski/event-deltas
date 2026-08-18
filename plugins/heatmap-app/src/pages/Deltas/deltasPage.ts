import { SceneAppPage } from '@grafana/scenes';
import { deltasScene } from './deltasScene';
import { prefixRoute } from '../../utils/utils.routing';
import { ROUTES } from '../../constants';

export const explorerPage = new SceneAppPage({
  title: 'Event Deltas',
  url: prefixRoute(ROUTES.Explorer),
  routePath: ROUTES.Explorer,
  subTitle: 'Select spans on the heatmap and continue investigation from the explorer.',
  getScene: () => deltasScene('explorer'),
});
