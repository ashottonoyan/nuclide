/**
 * Copyright (c) 2017-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @flow
 * @format
 */

import {
  translateMessageFromServer,
  translateMessageToServer,
} from '../ChromeMessageRemoting';

describe('debugger-base ChromeMessageRemoting', () => {
  it('translateMessageFromServer', () => {
    expect(
      translateMessageFromServer(
        'myhost',
        JSON.stringify({
          method: 'Debugger.scriptParsed',
          params: {
            scriptId: '/home/test.extension',
            url: 'file:///home/test.extension',
            startLine: 0,
            startColumn: 0,
            endLine: 0,
            endColumn: 0,
          },
        }),
      ),
    ).toBe(
      JSON.stringify({
        method: 'Debugger.scriptParsed',
        params: {
          scriptId: '/home/test.extension',
          url: 'nuclide://myhost/home/test.extension',
          startLine: 0,
          startColumn: 0,
          endLine: 0,
          endColumn: 0,
        },
      }),
    );
  });

  it('translateMessageFromServer with space', () => {
    expect(
      translateMessageFromServer(
        'myhost',
        JSON.stringify({
          method: 'Debugger.scriptParsed',
          params: {
            scriptId: '/home/te st.extension',
            url: 'file:///home/te st.extension',
            startLine: 0,
            startColumn: 0,
            endLine: 0,
            endColumn: 0,
          },
        }),
      ),
    ).toBe(
      JSON.stringify({
        method: 'Debugger.scriptParsed',
        params: {
          scriptId: '/home/te st.extension',
          url: 'nuclide://myhost/home/te st.extension',
          startLine: 0,
          startColumn: 0,
          endLine: 0,
          endColumn: 0,
        },
      }),
    );
  });

  it('translateMessageToServer', () => {
    expect(
      translateMessageToServer(
        JSON.stringify({
          method: 'Debugger.setBreakpointByUrl',
          params: {
            lineNumber: 3,
            url: 'nuclide://myhost/home/test.extension',
            columnNumber: 0,
            condition: '',
          },
        }),
      ),
    ).toBe(
      JSON.stringify({
        method: 'Debugger.setBreakpointByUrl',
        params: {
          lineNumber: 3,
          url: 'file:///home/test.extension',
          columnNumber: 0,
          condition: '',
        },
      }),
    );
  });
});
