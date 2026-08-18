global.IntersectionObserver = class IntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const { explorerPage } = require('./pages/Deltas/deltasPage');
const { tracePage } = require('./pages/Trace/tracePage');
const { prefixRoute } = require('./utils/utils.routing');
const { ROUTES } = require('./constants');

describe('trace routing', () => {
  it('registers explorer page as the default workbench route', () => {
    expect(explorerPage.state.routePath).toBe(ROUTES.Explorer);
    expect(explorerPage.state.drilldowns).toBeUndefined();
  });

  it('registers explicit trace route page with explorer parent', () => {
    expect(tracePage.state.url).toBe(prefixRoute(ROUTES.Trace));
    expect(tracePage.state.routePath).toBe(`${ROUTES.Trace}/:traceId`);
    expect(tracePage.state.getParentPage()).toBe(explorerPage);
  });
});
