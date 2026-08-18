import React from 'react';
import { SceneApp, useSceneApp } from '@grafana/scenes';
import { AppRootProps } from '@grafana/data';
import { PluginPropsContext } from '../../utils/utils.plugin';
import { setAppConfig, EventDeltasJsonData } from '../../appConfig';
import { explorerPage } from '../../pages/Deltas/deltasPage';
import { tracePage } from '../../pages/Trace/tracePage';

function getSceneApp() {
  return new SceneApp({
    pages: [explorerPage, tracePage],
    urlSyncOptions: {
      updateUrlOnInit: true,
      createBrowserHistorySteps: true,
    },
  });
}

function AppWithScenes() {
  const scene = useSceneApp(getSceneApp);
  return <scene.Component model={scene} />;
}

function App(props: AppRootProps<EventDeltasJsonData>) {
  // Before the scenes build their queries: they read the resolved config as
  // they are constructed.
  setAppConfig(props.meta.jsonData);

  return (
    <PluginPropsContext.Provider value={props}>
      <AppWithScenes />
    </PluginPropsContext.Provider>
  );
}

export default App;
