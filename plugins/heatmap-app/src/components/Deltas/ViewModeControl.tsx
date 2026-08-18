import React from 'react';
import { SceneObjectBase, SceneObjectState, SceneComponentProps } from '@grafana/scenes';
import { RadioButtonGroup } from '@grafana/ui';

export type ViewMode = 'latency' | 'errors';

export interface ViewModeState extends SceneObjectState {
  mode: ViewMode;
}

const MODE_OPTIONS: Array<{ value: ViewMode; label: string }> = [
  { value: 'latency', label: 'Latency' },
  { value: 'errors', label: 'Errors' },
];

export class ViewModeControl extends SceneObjectBase<ViewModeState> {
  constructor() {
    super({ mode: 'latency' });
  }

  static Component = ({ model }: SceneComponentProps<ViewModeControl>) => {
    const { mode } = model.useState();
    return (
      <RadioButtonGroup
        options={MODE_OPTIONS}
        value={mode}
        onChange={(v) => model.setState({ mode: v })}
        size="sm"
      />
    );
  };
}
