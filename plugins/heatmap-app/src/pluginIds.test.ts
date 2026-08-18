// Jest globals imported explicitly: @types/jest is hoisted to repo-root node_modules,
// outside the scaffold's typeRoots, so tsc can't see ambient describe/it/expect.
import { describe, expect, it } from '@jest/globals';

// Grafana rejects a submitted archive whose plugin.json id does not match this,
// with "plugin.json invalid: /id must match pattern". Copied verbatim from that
// error rather than paraphrased: at most <org>-<name>-<type>, and <name> cannot
// itself contain a dash. jordo-event-deltas-panel failed on submission because
// "event-deltas" reads as two segments.
const GRAFANA_PLUGIN_ID = /^[0-9a-z]+-([0-9a-z]+-)?(app|panel|datasource)$/;

const MANIFESTS = [
  'heatmap-panel',
  'timeseries-selection-panel',
  'heatmap-app',
  'slo-app',
].map((dir) => ({
  dir,
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  manifest: require(`../../${dir}/src/plugin.json`) as {
    id: string;
    type: string;
    dependencies: { plugins?: Array<{ id: string; type: string }> };
  },
}));

describe('plugin ids are submittable to the Grafana catalog', () => {
  it.each(MANIFESTS)('$dir has a valid id', ({ manifest }) => {
    expect(manifest.id).toMatch(GRAFANA_PLUGIN_ID);
  });

  it.each(MANIFESTS)('$dir id ends with its plugin type', ({ manifest }) => {
    expect(manifest.id.endsWith(`-${manifest.type}`)).toBe(true);
  });

  it('declared plugin dependencies point at ids that exist here', () => {
    const known = new Set(MANIFESTS.map((m) => m.manifest.id));
    for (const { manifest } of MANIFESTS) {
      for (const dep of manifest.dependencies.plugins ?? []) {
        expect(known).toContain(dep.id);
      }
    }
  });
});
