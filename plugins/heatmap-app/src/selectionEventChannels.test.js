const { HeatmapSelectionEvent, HeatmapSelectionClearedEvent } = require('../../heatmap-panel/src/types');
const { TimeseriesSelectionEvent, TimeseriesSelectionClearedEvent } = require('../../timeseries-selection-panel/src/types');
const { HeatmapSelectionEvent: SharedSelectionEvent, HeatmapSelectionClearedEvent: SharedSelectionClearedEvent } = require('../../../packages/shared-comparison/src/types');

// The channel strings are duplicated by hand in three places and plugins release
// independently, so a partial rename breaks selection between mismatched versions.
describe('selection event channel compatibility', () => {
  it('uses the same selection channel across heatmap and timeseries panels', () => {
    expect(TimeseriesSelectionEvent.type).toBe(HeatmapSelectionEvent.type);
  });

  it('uses the same selection-clear channel across heatmap and timeseries panels', () => {
    expect(TimeseriesSelectionClearedEvent.type).toBe(HeatmapSelectionClearedEvent.type);
  });

  it('uses the same channels in shared-comparison, which consumes both', () => {
    expect(SharedSelectionEvent.type).toBe(HeatmapSelectionEvent.type);
    expect(SharedSelectionClearedEvent.type).toBe(HeatmapSelectionClearedEvent.type);
  });

  it('pins the channel strings', () => {
    expect(HeatmapSelectionEvent.type).toBe('event-deltas-selection');
    expect(HeatmapSelectionClearedEvent.type).toBe('event-deltas-selection-clear');
  });
});
