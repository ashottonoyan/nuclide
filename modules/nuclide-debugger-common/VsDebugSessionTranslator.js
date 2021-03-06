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

import type {
  AtomNotificationType,
  DebuggerConfigAction,
  VsAdapterType,
  VSAdapterExecutableInfo,
  UserOutput,
  UserOutputLevel,
} from './types';

import type ClientCallback from './ClientCallback';
import type {NuclideUri} from 'nuclide-commons/nuclideUri';
import * as NuclideDebugProtocol from './protocol-types';
import * as DebugProtocol from 'vscode-debugprotocol';

import {arrayFlatten} from 'nuclide-commons/collection';
import FileCache from './FileCache';
import invariant from 'assert';
import {pathToUri, uriToPath} from './helpers';
import nuclideUri from 'nuclide-commons/nuclideUri';
import UniversalDisposable from 'nuclide-commons/UniversalDisposable';
import VsDebugSession from './VsDebugSession';
import {VsAdapterTypes} from './constants';
import {Observable, Subject} from 'rxjs';
import util from 'util';

function nuclideDebuggerLocation(
  scriptId: string,
  lineNumber: number,
  columnNumber: number,
): NuclideDebugProtocol.Location {
  return {
    scriptId,
    lineNumber,
    columnNumber,
  };
}

function getFakeLoaderPauseEvent(): NuclideDebugProtocol.DebuggerEvent {
  return {
    method: 'Debugger.paused',
    params: {
      callFrames: [],
      reason: 'initial break',
      data: {},
    },
  };
}

function getEmptyResponse(id: number): NuclideDebugProtocol.DebuggerResponse {
  return {id, result: {}};
}

function getErrorResponse(
  id: number,
  message: string,
): NuclideDebugProtocol.DebuggerResponse {
  return {id, error: {message}};
}

type CommandHandler = (
  command: NuclideDebugProtocol.DebuggerCommand,
) => Promise<
  NuclideDebugProtocol.DebuggerResponse | NuclideDebugProtocol.DebuggerEvent,
>;

/**
 * Instead of having every async command handler try/catch its own logic
 * and send error response when failing, this utility would provide
 * the try/catch wrapper for command handlers.
 */
function catchCommandError(handler: CommandHandler): CommandHandler {
  return async (command: NuclideDebugProtocol.DebuggerCommand) => {
    try {
      return await handler(command);
    } catch (error) {
      return getErrorResponse(command.id, error.message);
    }
  };
}

const OUTPUT_CATEGORY_TO_LEVEL = Object.freeze({
  console: 'debug',
  info: 'info',
  log: 'log',
  warning: 'warning',
  error: 'error',
  debug: 'debug',
  stderr: 'error',
  stdout: 'log',
  success: 'success',
});

// VSP deoesn't provide process id.
const VSP_PROCESS_ID = -1;

type TranslatorBreakpoint = {
  breakpointId: ?NuclideDebugProtocol.BreakpointId,
  path: NuclideUri,
  lineNumber: number,
  condition: string,
  hitCount: number,
  resolved: boolean,
};

type ThreadState = 'running' | 'paused';

type ThreadInfo = {
  state: ThreadState,
  callFrames?: NuclideDebugProtocol.CallFrame[],
  callStackLoaded: boolean,
  stopReason?: string,
};

/**
 * This translator will be responsible of mapping Nuclide's debugger protocol
 * requests to VSCode debugger protocol requests and back from VSCode's response
 * to Nuclide's responses and events.
 */
export default class VsDebugSessionTranslator {
  _adapterType: VsAdapterType;
  _session: VsDebugSession;
  _logger: log4js$Logger;
  _clientCallback: ClientCallback;
  _files: FileCache;
  _disposables: UniversalDisposable;
  _commands: Subject<NuclideDebugProtocol.DebuggerCommand>;
  _handledCommands: Set<string>;
  _breakpoints: Array<TranslatorBreakpoint>;

  _configDoneSent: boolean;
  _lastBreakpointId: number;
  _threadsById: Map<number, ThreadInfo>;
  _debuggerArgs: Object;
  _debugMode: DebuggerConfigAction;
  _exceptionFilters: Array<string>;

  // Session state.
  _pausedThreadId: ?number;
  _pausedThreadIdPrevious: ?number;

  constructor(
    adapterType: VsAdapterType,
    adapter: VSAdapterExecutableInfo,
    debugMode: DebuggerConfigAction,
    debuggerArgs: Object,
    clientCallback: ClientCallback,
    logger: log4js$Logger,
  ) {
    this._adapterType = adapterType;
    this._debugMode = debugMode;
    this._session = new VsDebugSession('id', logger, adapter);
    this._debuggerArgs = debuggerArgs;
    this._clientCallback = clientCallback;
    this._logger = logger;
    this._commands = new Subject();
    this._handledCommands = new Set();
    this._breakpoints = [];
    this._threadsById = new Map();
    this._lastBreakpointId = 0;
    this._configDoneSent = false;
    this._exceptionFilters = [];
    this._pausedThreadId = null;
    this._files = new FileCache((method, params) =>
      this._sendMessageToClient(({method, params}: any)),
    );

    // Ignore the first fake pause request.
    this._disposables = new UniversalDisposable(
      this._session,
      this._handleCommands().subscribe(message =>
        this._sendMessageToClient(message),
      ),
      this._listenToSessionEvents(),
    );
  }

  _updatePausedThreadId(newPausedThreadId: ?number) {
    if (this._pausedThreadId != null) {
      this._pausedThreadIdPrevious = this._pausedThreadId;
    }

    this._pausedThreadId = newPausedThreadId;
  }

  _handleCommands(): Observable<
    NuclideDebugProtocol.DebuggerResponse | NuclideDebugProtocol.DebuggerEvent,
  > {
    const resumeCommands = this._commandsOfType('Debugger.resume');
    return Observable.merge(
      // Ack debugger enabled and send fake pause event
      // (indicating readiness to receive config requests).
      this._commandsOfType('Debugger.enable').flatMap(command =>
        Observable.of(getEmptyResponse(command.id), getFakeLoaderPauseEvent()),
      ),
      this._commandsOfType('Debugger.pause').flatMap(
        catchCommandError(async command => {
          const pausedThreadId =
            this._pausedThreadId != null
              ? this._pausedThreadId
              : Array.from(this._threadsById.keys())[0] || -1;
          this._updatePausedThreadId(null);
          await this._session.pause({threadId: pausedThreadId});
          return getEmptyResponse(command.id);
        }),
      ),
      // Skip the fake resume command.
      resumeCommands.skip(1).flatMap(
        catchCommandError(async command => {
          const threadId =
            this._pausedThreadId != null ? this._pausedThreadId : -1;
          await this._session.continue({threadId});
          return getEmptyResponse(command.id);
        }),
      ),
      // Select thread.
      this._commandsOfType('Debugger.selectThread').flatMap(command => {
        invariant(command.method === 'Debugger.selectThread');
        this._updatePausedThreadId(command.params.threadId);
        return Observable.of(getEmptyResponse(command.id));
      }),
      // Step over
      this._commandsOfType('Debugger.stepOver').flatMap(
        catchCommandError(async command => {
          if (this._pausedThreadId == null) {
            return getErrorResponse(
              command.id,
              'No paused thread to step over!',
            );
          }
          await this._session.next({threadId: this._pausedThreadId});
          return getEmptyResponse(command.id);
        }),
      ),
      // Step into
      this._commandsOfType('Debugger.stepInto').flatMap(
        catchCommandError(async command => {
          if (this._pausedThreadId == null) {
            return getErrorResponse(
              command.id,
              'No paused thread to step into!',
            );
          }
          await this._session.stepIn({threadId: this._pausedThreadId});
          return getEmptyResponse(command.id);
        }),
      ),
      // Step out
      this._commandsOfType('Debugger.stepOut').flatMap(
        catchCommandError(async command => {
          if (this._pausedThreadId == null) {
            return getErrorResponse(
              command.id,
              'No paused thread to step out!',
            );
          }
          await this._session.stepOut({threadId: this._pausedThreadId});
          return getEmptyResponse(command.id);
        }),
      ),
      // Request completions
      this._commandsOfType('Debugger.completions').flatMap(
        catchCommandError(async command => {
          invariant(command.method === 'Debugger.completions');
          const {text, column, frameId} = command.params;
          if (!this._session.getCapabilities().supportsCompletionsRequest) {
            // Not supported, return empty result.
            return {id: command.id, result: {targets: []}};
          }
          const {body} = await this._session.completions({
            text,
            column,
            frameId,
          });
          const result: NuclideDebugProtocol.GetCompletionsResponse = {
            targets: body.targets,
          };
          return {id: command.id, result};
        }),
      ),
      // Get script source
      this._commandsOfType('Debugger.getScriptSource').flatMap(
        catchCommandError(async command => {
          invariant(command.method === 'Debugger.getScriptSource');
          const result: NuclideDebugProtocol.GetScriptSourceResponse = {
            scriptSource: await this._files.getFileSource(
              command.params.scriptId,
            ),
          };
          return {id: command.id, result};
        }),
      ),
      this._commandsOfType('Debugger.setPauseOnExceptions').switchMap(
        catchCommandError(async command => {
          invariant(command.method === 'Debugger.setPauseOnExceptions');
          const {state} = command.params;
          switch (state) {
            case 'none':
              this._exceptionFilters = [];
              break;
            case 'uncaught':
            case 'all':
              this._exceptionFilters = [state];
              break;
          }
          if (this._configDoneSent) {
            await this._session.setExceptionBreakpoints({
              filters: this._exceptionFilters,
            });
          }
          return getEmptyResponse(command.id);
        }),
      ),
      this._commandsOfType('Debugger.continueToLocation').switchMap(
        catchCommandError(async command => {
          invariant(command.method === 'Debugger.continueToLocation');
          const {location} = command.params;
          await this._continueToLocation(location);
          return getEmptyResponse(command.id);
        }),
      ),
      // Ack config commands
      Observable.merge(
        this._commandsOfType('Debugger.setDebuggerSettings'),
        this._commandsOfType('Runtime.enable'),
      ).map(command => getEmptyResponse(command.id)),
      // Get properties
      this._commandsOfType('Runtime.getProperties').flatMap(
        catchCommandError(async command => {
          invariant(command.method === 'Runtime.getProperties');
          const result = await this._getProperties(command.id, command.params);
          return ({id: command.id, result}: any);
        }),
      ),
      // Set breakpoints
      this._handleSetBreakpointsCommands(),
      // Ack first resume command (indicating the session is ready to start).
      resumeCommands.take(1).map(command => getEmptyResponse(command.id)),
      // Remove breakpoints
      this._commandsOfType('Debugger.removeBreakpoint').flatMap(
        catchCommandError(async command => {
          invariant(command.method === 'Debugger.removeBreakpoint');
          await this._removeBreakpoint(command.params.breakpointId);
          return getEmptyResponse(command.id);
        }),
      ),
      this._commandsOfType('Debugger.getThreadStack').flatMap(async command => {
        invariant(command.method === 'Debugger.getThreadStack');
        const {threadId} = command.params;
        const threadInfo = this._threadsById.get(threadId);
        let callFrames = null;
        if (threadInfo != null && threadInfo.state === 'paused') {
          callFrames = threadInfo.callFrames;
          if (
            threadInfo.callFrames == null ||
            threadInfo.callFrames.length === 0 ||
            !threadInfo.callStackLoaded
          ) {
            // Need to fetch this thread's frames.
            threadInfo.callFrames = await this._getTranslatedCallFramesForThread(
              command.params.threadId,
              null,
            );
            callFrames = threadInfo.callFrames;
          }
        }
        const result: NuclideDebugProtocol.GetThreadStackResponse = {
          callFrames: callFrames || [],
        };
        return {
          id: command.id,
          result,
        };
      }),
      this._commandsOfType('Debugger.evaluateOnCallFrame').flatMap(
        async command => {
          invariant(command.method === 'Debugger.evaluateOnCallFrame');
          const {callFrameId, expression} = command.params;
          const result: NuclideDebugProtocol.EvaluateResponse = await this._evaluateOnCallFrame(
            expression,
            Number(callFrameId),
          );
          return {
            id: command.id,
            result,
          };
        },
      ),
      this._commandsOfType('Debugger.setVariableValue').flatMap(
        catchCommandError(async command => {
          invariant(command.method === 'Debugger.setVariableValue');
          const {callFrameId, name, value} = command.params;
          const args = {
            variablesReference: callFrameId,
            name,
            value,
          };
          const {body} = await this._session.setVariable(args);
          const result: NuclideDebugProtocol.SetVariableResponse = {
            value: body.value,
          };
          return {
            id: command.id,
            result,
          };
        }),
      ),
      this._commandsOfType('Runtime.evaluate').flatMap(async command => {
        invariant(command.method === 'Runtime.evaluate');
        const {expression} = command.params;
        const result: NuclideDebugProtocol.EvaluateResponse = await this._evaluateOnCallFrame(
          expression,
        );
        return {
          id: command.id,
          result,
        };
      }),
      // Error for unhandled commands
      this._unhandledCommands().map(command =>
        getErrorResponse(command.id, 'Unknown command: ' + command.method),
      ),
    );
  }

  async _continueToLocation(
    location: NuclideDebugProtocol.Location,
  ): Promise<void> {
    const {columnNumber, lineNumber, scriptId, threadId} = location;
    const source = {
      path: nuclideUri.getPath(scriptId),
      name: nuclideUri.basename(scriptId),
    };
    await this._files.registerFile(pathToUri(scriptId));
    const args: Object = {
      // flowlint-next-line sketchy-null-number:off
      column: columnNumber || 1,
      line: lineNumber + 1,
      source,
    };
    if (threadId != null) {
      args.threadId = threadId;
    }
    await this._session.nuclide_continueToLocation(args);
  }

  _handleSetBreakpointsCommands(): Observable<
    NuclideDebugProtocol.DebuggerResponse,
  > {
    const setBreakpointsCommands = this._commandsOfType(
      'Debugger.setBreakpointByUrl',
    );

    return Observable.concat(
      setBreakpointsCommands
        .buffer(
          this._commandsOfType('Debugger.resume')
            .first()
            .switchMap(async () => {
              await this._startDebugging();
              if (!this._session.isReadyForBreakpoints()) {
                await this._session
                  .observeInitializeEvents()
                  .first()
                  .toPromise();
              }
            }),
        )
        .first()
        .flatMap(async commands => {
          // Upon session start, send the cached breakpoints
          // and other configuration requests.
          try {
            const breakpoints = await this._setBulkBreakpoints(commands);
            await this._configDone();
            return breakpoints;
          } catch (error) {
            return commands.map(({id}) => getErrorResponse(id, error.message));
          }
        }),
      // Following breakpoint requests are handled by
      // immediatelly passing to the active debug session.
      setBreakpointsCommands.flatMap(async command => {
        try {
          return await this._setBulkBreakpoints([command]);
        } catch (error) {
          return [getErrorResponse(command.id, error.message)];
        }
      }),
    ).flatMap(responses => Observable.from(responses));
  }

  async _startDebugging(): Promise<void> {
    try {
      if (this._debugMode === 'launch') {
        await this._session.launch(this._debuggerArgs);
      } else {
        await this._session.attach(this._debuggerArgs);
      }
    } catch (error) {
      this._terminateSessionWithError(
        `Failed to ${this._debugMode} the debugger!`,
        error,
      );
    }
  }

  async _setBulkBreakpoints(
    setBreakpointsCommands: Array<NuclideDebugProtocol.DebuggerCommand>,
  ): Promise<Array<NuclideDebugProtocol.DebuggerResponse>> {
    if (!this._session.isReadyForBreakpoints()) {
      throw new Error('VsDebugSession is not ready for breakpoints');
    }
    if (setBreakpointsCommands.length === 0) {
      return [];
    }
    // Group breakpoint commands by file path.
    const breakpointCommandsByUrl = new Map();
    for (const command of setBreakpointsCommands) {
      invariant(command.method === 'Debugger.setBreakpointByUrl');
      const url = decodeURIComponent(command.params.url);
      const existing = breakpointCommandsByUrl.get(url);
      if (existing == null) {
        breakpointCommandsByUrl.set(url, [command]);
      } else {
        existing.push(command);
      }
    }

    const responseGroups = await Promise.all(
      Array.from(breakpointCommandsByUrl).map(
        async ([url, breakpointCommands]) => {
          const path = uriToPath(url);

          const existingTranslatorBreakpoints = this._getBreakpointsForFilePath(
            path,
          ).map(bp => ({...bp}));

          const breakOnLineNumbers = new Set();

          const translatorBreakpoins = breakpointCommands
            .map(c => {
              const newTranslatorBp = {
                breakpointId: null,
                path,
                lineNumber: c.params.lineNumber + 1,
                condition: c.params.condition || '',
                resolved: false,
                hitCount: 0,
              };
              breakOnLineNumbers.add(newTranslatorBp.lineNumber);
              this._breakpoints.push(newTranslatorBp);
              return newTranslatorBp;
            })
            .concat(
              existingTranslatorBreakpoints.filter(
                tBp => !breakOnLineNumbers.has(tBp.lineNumber),
              ),
            );

          await this._files.registerFile(url);
          await this._syncBreakpointsForFilePath(path, translatorBreakpoins);

          return breakpointCommands.map((command, i) => {
            const {breakpointId, lineNumber, resolved} = translatorBreakpoins[
              i
            ];

            invariant(breakpointId != null);
            const result: NuclideDebugProtocol.SetBreakpointByUrlResponse = {
              breakpointId,
              locations: [nuclideDebuggerLocation(path, lineNumber - 1, 0)],
              resolved,
            };
            return {
              id: command.id,
              result,
            };
          });
        },
      ),
    );
    return arrayFlatten(responseGroups);
  }

  _syncBreakpoints(): Promise<mixed> {
    const filePaths = new Set(this._breakpoints.map(bp => bp.path));
    const setBreakpointPromises = [];
    for (const filePath of filePaths) {
      setBreakpointPromises.push(
        this._syncBreakpointsForFilePath(
          filePath,
          this._getBreakpointsForFilePath(filePath).map(bp => ({...bp})),
        ),
      );
    }
    return Promise.all(setBreakpointPromises);
  }

  async _configDone(): Promise<void> {
    await this._session.setExceptionBreakpoints({
      filters: this._exceptionFilters,
    });
    if (this._session.getCapabilities().supportsConfigurationDoneRequest) {
      await this._session.configurationDone();
    }
    this._configDoneSent = true;
  }

  _tryUpdateBreakpoint(
    breakpoint: TranslatorBreakpoint,
    vsBreakpoint: DebugProtocol.Breakpoint,
  ): void {
    if (!breakpoint.resolved && vsBreakpoint.verified) {
      breakpoint.resolved = true;
    }

    if (vsBreakpoint.line != null) {
      const lineNumber = parseInt(vsBreakpoint.line, 10);
      if (!Number.isNaN(lineNumber) && lineNumber !== breakpoint.line) {
        // Breakpoint resolved to a different line number by the engine.
        breakpoint.lineNumber = lineNumber;
      }
    }
  }

  async _syncBreakpointsForFilePath(
    path: NuclideUri,
    breakpoints: Array<TranslatorBreakpoint>,
  ): Promise<void> {
    const source = {path, name: nuclideUri.basename(path)};
    const {
      body: {breakpoints: vsBreakpoints},
    } = await this._session.setBreakpoints({
      source,
      lines: breakpoints.map(bp => bp.lineNumber),
      breakpoints: breakpoints.map(bp => ({
        line: bp.lineNumber,
        condition: bp.condition,
      })),
    });
    if (vsBreakpoints.length !== breakpoints.length) {
      const errorMessage =
        'Failed to set breakpoints - count mismatch!' +
        ` ${vsBreakpoints.length} vs. ${breakpoints.length}`;
      this._logger.error(
        errorMessage,
        JSON.stringify(vsBreakpoints),
        JSON.stringify(breakpoints),
      );
      throw new Error(errorMessage);
    }
    vsBreakpoints.forEach((vsBreakpoint, i) => {
      if (breakpoints[i].breakpointId == null) {
        breakpoints[i].breakpointId = String(
          vsBreakpoint.id == null ? this._nextBreakpointId() : vsBreakpoint.id,
        );
      }
      this._tryUpdateBreakpoint(breakpoints[i], vsBreakpoint);
    });
  }

  async _removeBreakpoint(
    breakpointId: NuclideDebugProtocol.BreakpointId,
  ): Promise<void> {
    const foundBreakpointIdx = this._breakpoints.findIndex(
      bp => bp.breakpointId === breakpointId,
    );
    if (foundBreakpointIdx === -1) {
      this._logger.info(`No breakpoint with id: ${breakpointId} to remove!`);
      return;
    }
    const foundBreakpoint = this._breakpoints[foundBreakpointIdx];
    const remainingBreakpoints = this._getBreakpointsForFilePath(
      foundBreakpoint.path,
    ).filter(breakpoint => breakpoint.breakpointId !== breakpointId);
    this._breakpoints.splice(foundBreakpointIdx, 1);

    await this._syncBreakpointsForFilePath(
      foundBreakpoint.path,
      remainingBreakpoints.map(bp => ({
        ...bp,
      })),
    );
  }

  async _evaluateOnCallFrame(
    expression: string,
    frameId?: number,
  ): Promise<NuclideDebugProtocol.EvaluateResponse> {
    try {
      const {body} = await this._session.evaluate({
        expression,
        frameId,
      });
      return {
        result: {
          type: (body.type: any),
          value: body.result,
          description: body.result,
          objectId:
            body.variablesReference > 0
              ? String(body.variablesReference)
              : undefined,
        },
        wasThrown: false,
      };
    } catch (error) {
      return {
        result: {
          type: 'undefined',
        },
        exceptionDetails: error.message,
        wasThrown: true,
      };
    }
  }

  _getBreakpointsForFilePath(path: NuclideUri): Array<TranslatorBreakpoint> {
    return this._breakpoints.filter(breakpoint => breakpoint.path === path);
  }

  _nextBreakpointId(): number {
    return ++this._lastBreakpointId;
  }

  _commandsOfType(
    type: string,
  ): Observable<NuclideDebugProtocol.DebuggerCommand> {
    this._handledCommands.add(type);
    return this._commands.filter(c => c.method === type);
  }

  _unhandledCommands(): Observable<NuclideDebugProtocol.DebuggerCommand> {
    return this._commands.filter(c => !this._handledCommands.has(c.method));
  }

  _listenToSessionEvents(): IDisposable {
    // The first resume command is the indicator of client readiness
    // to receive session events.
    return new UniversalDisposable(
      this._session.observeAllEvents().subscribe(event => {
        this._logger.info('VSP Event', event);
      }),
      this._session.observeThreadEvents().subscribe(({body}) => {
        const {reason, threadId} = body;
        if (reason === 'started') {
          this._updateThreadsState([threadId], 'running');
        } else if (reason === 'exited') {
          this._threadsById.delete(threadId);
          if (this._pausedThreadId === threadId) {
            this._updatePausedThreadId(null);
          }
        } else {
          this._logger.error('Unknown thread event:', body);
        }
        const threadsUpdatedEvent = this._getThreadsUpdatedEvent();
        this._sendMessageToClient({
          method: 'Debugger.threadsUpdated',
          params: threadsUpdatedEvent,
        });
      }),
      this._session.observeBreakpointEvents().subscribe(({body}) => {
        const {breakpoint} = (body: {
          reason: string,
          breakpoint: DebugProtocol.Breakpoint,
        });
        const bpId = String(breakpoint.id == null ? -1 : breakpoint.id);

        // Find an existing breakpoint. Note the protocol doesn't provide
        // an original line here, only the resolved line. If the bp had to
        // be moved by the backend, this fails to find a match.
        const existingBreakpoint = this._breakpoints.find(
          bp =>
            bp.breakpointId === bpId ||
            (bp.breakpointId == null &&
              bp.lineNumber ===
                (breakpoint.originalLine != null
                  ? breakpoint.originalLine
                  : breakpoint.line) &&
              breakpoint.source != null &&
              bp.path === breakpoint.source.path),
        );
        const hitCount = parseInt(breakpoint.nuclide_hitCount, 10);

        if (existingBreakpoint == null) {
          this._logger.warn(
            'Received a breakpoint event, but cannot find the breakpoint',
          );
          return;
        } else if (breakpoint.verified) {
          this._tryUpdateBreakpoint(existingBreakpoint, breakpoint);
          this._sendMessageToClient({
            method: 'Debugger.breakpointResolved',
            params: {
              breakpointId: bpId,
              location: nuclideDebuggerLocation(
                existingBreakpoint.path,
                existingBreakpoint.lineNumber - 1,
                0,
              ),
            },
          });
        } else if (
          !Number.isNaN(hitCount) &&
          existingBreakpoint != null &&
          existingBreakpoint.hitCount !== hitCount
        ) {
          existingBreakpoint.hitCount = hitCount;
          this._sendMessageToClient({
            method: 'Debugger.breakpointHitCountChanged',
            params: {
              breakpointId: bpId,
              hitCount,
            },
          });
        } else {
          this._logger.warn('Unknown breakpoint event', body);
        }
      }),
      this._session
        .observeStopEvents()
        .flatMap(({body}) => {
          const {threadId, reason} = body;
          let {allThreadsStopped} = body;

          // Compatibility work around:
          //   Even though the python debugger engine pauses all threads,
          //   It only reports the main thread as paused. For this engine,
          //   behave as if allThreadsStopped == true.
          if (
            this._adapterType === VsAdapterTypes.PYTHON &&
            reason === 'user request'
          ) {
            allThreadsStopped = true;
          }

          const stoppedThreadIds = [];
          if (threadId != null && threadId >= 0) {
            // If a threadId was specified, always ask for the stack for that
            // thread.
            stoppedThreadIds.push(threadId);
          }

          if (allThreadsStopped) {
            // If all threads are stopped or no stop thread was specified, ask
            // for updated stacks from any thread that is not already paused.
            const allStoppedIds = Array.from(this._threadsById.keys()).filter(
              id => {
                const threadInfo = this._threadsById.get(id);
                return (
                  id !== threadId &&
                  threadInfo != null &&
                  threadInfo.state !== 'paused'
                );
              },
            );

            if (allStoppedIds.length > 0) {
              stoppedThreadIds.push(...allStoppedIds);
            }
          }

          // If this is the first thread to stop, use the stop thread ID
          // from this event as the currently selected thread in the UX.
          if (this._pausedThreadId == null && stoppedThreadIds.length > 0) {
            this._updatePausedThreadId(stoppedThreadIds[0]);
          }

          return Observable.fromPromise(
            Promise.all(
              stoppedThreadIds.map(async id => {
                let callFrames = [];
                try {
                  callFrames =
                    this._pausedThreadId === threadId
                      ? await this._getTranslatedCallFramesForThread(id, null)
                      : await this._getTranslatedCallFramesForThread(id, 1);
                } catch (e) {
                  callFrames = [];
                }
                const threadSwitchMessage =
                  this._pausedThreadIdPrevious != null &&
                  this._pausedThreadId != null &&
                  this._pausedThreadIdPrevious !== this._pausedThreadId
                    ? `Active thread switched from thread #${
                        this._pausedThreadIdPrevious
                      } to thread #${this._pausedThreadId}`
                    : null;
                const pausedEvent: NuclideDebugProtocol.PausedEvent = {
                  callFrames,
                  reason,
                  stopThreadId: id,
                  threadSwitchMessage,
                };
                return pausedEvent;
              }),
            ),
          )
            .takeUntil(
              // Stop processing this stop event if a continue event is seen before
              // the stop event is completely processed and sent to the UX.
              this._session
                .observeContinuedEvents()
                .filter(
                  e =>
                    e.body.allThreadsContinued === true ||
                    e.body.threadId == null ||
                    e.body.threadId === threadId,
                ),
            )
            .take(1);
        })
        .subscribe(
          pausedEvents => {
            for (const pausedEvent of pausedEvents) {
              // Mark the affected threads as paused and update their call frames.
              const {stopThreadId} = pausedEvent;
              if (stopThreadId != null && stopThreadId >= 0) {
                this._threadsById.set(stopThreadId, {
                  state: 'paused',
                  callFrames: pausedEvent.callFrames,
                  stopReason: pausedEvent.reason,
                  callStackLoaded: this._pausedThreadId === stopThreadId,
                });
              }
            }

            let pausedEvent: ?NuclideDebugProtocol.PausedEvent = null;
            if (pausedEvents.length === 0) {
              // This is expected in the case of an async-break where the
              // target has no threads running. We need to raise a Chrome
              // event or the UX spins forever and hangs.
              pausedEvent = {
                callFrames: [],
                reason: 'Async-Break',
                stopThreadId: -1,
                threadSwitchMessage: null,
              };
            } else if (
              this._pausedThreadId === pausedEvents[0].stopThreadId &&
              pausedEvents[0].stopThreadId != null
            ) {
              // Only send Debugger.Paused for the first thread that stops
              // the debugger. Otherwise, we cause the selected thread in the
              // UX to jump around as additional threads pause.
              pausedEvent = pausedEvents[0];
            }

            if (pausedEvent != null) {
              this._sendMessageToClient({
                method: 'Debugger.paused',
                params: pausedEvent,
              });
            }

            const threadsUpdatedEvent = this._getThreadsUpdatedEvent();
            threadsUpdatedEvent.stopThreadId =
              this._pausedThreadId != null ? this._pausedThreadId : -1;
            this._sendMessageToClient({
              method: 'Debugger.threadsUpdated',
              params: threadsUpdatedEvent,
            });
          },
          error =>
            this._terminateSessionWithError(
              'Unable to translate stop event / call stack',
              error,
            ),
        ),
      this._session.observeContinuedEvents().subscribe(({body}) => {
        const {threadId} = body;
        let {allThreadsContinued} = body;

        if (threadId == null || threadId < 0) {
          allThreadsContinued = true;
        }

        if (allThreadsContinued || threadId === this._pausedThreadId) {
          this._updatePausedThreadId(null);
        }

        const continuedThreadIds = allThreadsContinued
          ? Array.from(this._threadsById.keys()).filter(id => {
              const threadInfo = this._threadsById.get(id);
              return threadInfo != null && threadInfo.state !== 'running';
            })
          : [threadId];

        this._updateThreadsState(continuedThreadIds, 'running');
        this._sendMessageToClient({method: 'Debugger.resumed'});
      }),
      this._session.observeOutputEvents().subscribe(({body}) => {
        // flowlint-next-line sketchy-null-string:off
        const category = body.category || 'console';
        const level = OUTPUT_CATEGORY_TO_LEVEL[category];
        const output = (body.output || '').replace(/\r?\n$/, '');
        if (level != null && output.length > 0) {
          this._sendUserOutputMessage(level, output);
        } else if (category === 'nuclide_notification') {
          invariant(body.data);
          this._sendAtomNotification(body.data.type, body.output);
        }
      }),
      this._session
        .observeInitializeEvents()
        // The first initialized event is used for breakpoint handling
        // and launch synchronization.
        .skip(1)
        // Next initialized events are session restarts.
        // Hence, we need to sync breakpoints & config done.
        .switchMap(async () => {
          await this._syncBreakpoints();
          await this._configDone();
        })
        .subscribe(
          () => this._logger.info('Session synced'),
          error =>
            this._terminateSessionWithError('Unable to sync session', error),
        ),
    );
  }

  _terminateSessionWithError(errorMessage: string, error: any) {
    this._logger.error(errorMessage, error);
    this._sendAtomNotification(
      'error',
      `${errorMessage}<br/>` + util.format(error),
    );
    this.dispose();
  }

  _updateThreadsState(threadIds: Iterable<number>, state: ThreadState): void {
    for (const threadId of threadIds) {
      const threadInfo = this._threadsById.get(threadId);
      if (threadInfo == null || state === 'running') {
        this._threadsById.set(threadId, {state, callStackLoaded: false});
      } else {
        this._threadsById.set(threadId, {
          ...threadInfo,
          state,
        });
      }
    }
  }

  _getThreadsUpdatedEvent(): NuclideDebugProtocol.ThreadsUpdatedEvent {
    const threads = Array.from(this._threadsById.entries()).map(
      ([id, {state, callFrames, stopReason}]) => {
        const topCallFrame = callFrames == null ? null : callFrames[0];
        const threadName = `Thread ${id}`;

        let address;
        let location;
        let hasSource;
        if (topCallFrame == null) {
          address = '';
          location = nuclideDebuggerLocation('N/A', 0, 0);
          hasSource = false;
        } else {
          address = topCallFrame.functionName;
          location = {...topCallFrame.location};
          hasSource = topCallFrame.hasSource === true;
        }

        return {
          id,
          name: threadName,
          description: threadName,
          address,
          location,
          // flowlint-next-line sketchy-null-string:off
          stopReason: stopReason || 'running',
          hasSource,
        };
      },
    );

    return {
      owningProcessId: VSP_PROCESS_ID,
      threads,
    };
  }

  async initilize(): Promise<void> {
    await this._session.initialize({
      clientID: 'Nuclide',
      adapterID: this._adapterType,
      linesStartAt1: true,
      columnsStartAt1: true,
      supportsVariableType: true,
      supportsVariablePaging: false,
      supportsRunInTerminalRequest: false,
      pathFormat: 'path',
    });
  }

  processCommand(command: NuclideDebugProtocol.DebuggerCommand): void {
    this._commands.next(command);
  }

  async _getTranslatedCallFramesForThread(
    threadId: number,
    levels: ?number = null,
  ): Promise<Array<NuclideDebugProtocol.CallFrame>> {
    try {
      const options = {};
      if (
        levels != null &&
        this._session.getCapabilities().supportsDelayedStackTraceLoading ===
          true
      ) {
        options.levels = levels;
        options.startFrame = 0;
      }
      const {body: {stackFrames}} = await this._session.stackTrace({
        threadId,
        ...options,
      });
      // $FlowFixMe(>=0.55.0) Flow suppress
      return Promise.all(
        stackFrames.map(async frame => {
          let scriptId;
          if (frame.source != null && frame.source.path != null) {
            scriptId = frame.source.path;
          } else {
            this._logger.error('Cannot find source/script of frame: ', frame);
            scriptId = 'N/A';
          }
          await this._files.registerFile(pathToUri(scriptId));
          return {
            callFrameId: String(frame.id),
            functionName: frame.name,
            location: nuclideDebuggerLocation(
              scriptId,
              frame.line - 1,
              frame.column - 1,
            ),
            hasSource: frame.source != null,
            scopeChain: await this._getScopesForFrame(frame.id),
            this: (undefined: any),
          };
        }),
      );
    } catch (e) {
      // This is expected in some situations, such as if stacks were requested
      // asynchronously but the target resumed before the request was received.
      // Throwing here or failing to provide a stack completely breaks the
      // state machine in the Nuclide UX layer.
      this._logger.error('Could not get stack traces: ', e.message);
      return [];
    }
  }

  async _getScopesForFrame(
    frameId: number,
  ): Promise<Array<NuclideDebugProtocol.Scope>> {
    try {
      const {body: {scopes}} = await this._session.scopes({frameId});
      return scopes.map(scope => ({
        type: (scope.name: any),
        name: scope.name,
        object: {
          type: 'object',
          description: scope.name,
          objectId: String(scope.variablesReference),
        },
      }));
    } catch (e) {
      // This is expected in some situations, such as if scopes were requested
      // asynchronously but the target resumed before the request was received.
      this._logger.error('Could not get frame scopes: ', e.message);
      return [];
    }
  }

  async _getProperties(
    id: number,
    params: NuclideDebugProtocol.GetPropertiesRequest,
  ): Promise<NuclideDebugProtocol.GetPropertiesResponse> {
    const variablesReference = Number(params.objectId);
    const {body: {variables}} = await this._session.variables({
      variablesReference,
    });
    const propertyDescriptors = variables.map(variable => {
      const value = {
        type: (variable.type: any),
        value: variable.value,
        description: variable.value,
        objectId:
          variable.variablesReference > 0
            ? String(variable.variablesReference)
            : undefined,
      };
      return {
        name: variable.name,
        value,
        configurable: false,
        enumerable: true,
      };
    });
    return {
      result: propertyDescriptors,
    };
  }

  _sendMessageToClient(
    message:
      | NuclideDebugProtocol.DebuggerResponse
      | NuclideDebugProtocol.DebuggerEvent,
  ): void {
    this._logger.info('Sent message to client', JSON.stringify(message));
    this._clientCallback.sendChromeMessage(JSON.stringify(message));
  }

  _sendAtomNotification(level: AtomNotificationType, message: string): void {
    this._clientCallback.sendAtomNotification(level, message);
  }

  _sendUserOutputMessage(level: UserOutputLevel, text: string): void {
    const message: UserOutput = {level, text};
    this._clientCallback.sendUserOutputMessage(JSON.stringify(message));
  }

  observeSessionEnd(): Observable<void> {
    return Observable.merge(
      this._session.observeExitedDebugeeEvents(),
      this._observeTerminatedDebugeeEvents(),
      this._session.observeAdapterExitedEvents(),
    ).map(() => undefined);
  }

  _observeTerminatedDebugeeEvents(): Observable<mixed> {
    // The service framework doesn't flush the last output messages
    // if the observables and session are eagerly terminated.
    // Hence, delaying 1 second.
    return this._session.observeTerminateDebugeeEvents().delay(1000);
  }

  getSession(): VsDebugSession {
    return this._session;
  }

  dispose(): void {
    this._disposables.dispose();
  }
}
