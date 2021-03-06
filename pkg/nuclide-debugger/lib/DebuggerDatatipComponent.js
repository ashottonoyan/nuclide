/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 *
 * @flow
 * @format
 */

import type {WatchExpressionStore} from './WatchExpressionStore';
import type {EvaluationResult} from './types';

import {LoadingSpinner} from 'nuclide-commons-ui/LoadingSpinner';
import * as React from 'react';
import {LazyNestedValueComponent} from 'nuclide-commons-ui/LazyNestedValueComponent';
import SimpleValueComponent from 'nuclide-commons-ui/SimpleValueComponent';

type Props = {|
  +expression: string,
  +evaluationResult: ?EvaluationResult,
  +watchExpressionStore: WatchExpressionStore,
|};

export class DebuggerDatatipComponent extends React.Component<Props> {
  render(): React.Node {
    const {expression, evaluationResult, watchExpressionStore} = this.props;
    const fetchChildren = watchExpressionStore.getProperties.bind(
      watchExpressionStore,
    );
    let datatipElement;
    if (evaluationResult == null) {
      datatipElement = <LoadingSpinner delay={100} size="EXTRA_SMALL" />;
    } else {
      datatipElement = (
        <span className="nuclide-debugger-datatip-value">
          <LazyNestedValueComponent
            evaluationResult={evaluationResult}
            expression={expression}
            fetchChildren={fetchChildren}
            simpleValueComponent={SimpleValueComponent}
            expansionStateId={this}
          />
        </span>
      );
    }
    return <div className="nuclide-debugger-datatip">{datatipElement}</div>;
  }
}
