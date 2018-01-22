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

import crypto from 'crypto';
import invariant from 'assert';
import url from 'url';
import uuid from 'uuid';

import type {Command} from '../nuclide-pty-rpc/rpc-types';
import type {IconName} from 'nuclide-commons-ui/Icon';

// Generate a unique random token that is included in every URI we generate.
// We use this to check that URIs containing shell commands and similarly
// sensitive data were generated by this instance of Nuclide.  The goal is
// to prevent externally generated URIs from ever resulting in command
// execution.
const trustToken = crypto.randomBytes(256).toString('hex');

export const URI_PREFIX = 'atom://nuclide-terminal-view';
export const TERMINAL_DEFAULT_LOCATION = 'pane';
export const TERMINAL_DEFAULT_ICON = 'terminal';
export const TERMINAL_DEFAULT_INFO: TerminalInfo = {
  remainOnCleanExit: false,
  defaultLocation: TERMINAL_DEFAULT_LOCATION,
  icon: TERMINAL_DEFAULT_ICON,
};

// Fields that are legal from untrusted sources.
type TerminalInfoUntrustedFields = {
  title?: string,
  key?: string,
  remainOnCleanExit: boolean,
  defaultLocation: string,
  icon: IconName,
  trustToken?: string,
};

// Fields that are only legal from trusted sources.
type TerminalInfoTrustedFields = {
  command?: Command,
  cwd?: string,
  environmentVariables?: Map<string, string>,
  preservedCommands?: Array<string>,
  initialInput?: string,
};

export type TerminalInfo = TerminalInfoUntrustedFields &
  TerminalInfoTrustedFields;

export function uriFromCwd(cwd: ?string): string {
  const cwdOptions = cwd == null ? {} : {cwd};
  return uriFromInfo({
    ...cwdOptions,
    ...TERMINAL_DEFAULT_INFO,
  });
}

export function uriFromInfo(info: TerminalInfo): string {
  const uri = url.format({
    protocol: 'atom',
    host: 'nuclide-terminal-view',
    slashes: true,
    query: {
      cwd: info.cwd == null ? '' : info.cwd,
      command: info.command == null ? '' : JSON.stringify(info.command),
      title: info.title == null ? '' : info.title,
      key: info.key != null && info.key !== '' ? info.key : uuid.v4(),
      remainOnCleanExit: info.remainOnCleanExit,
      defaultLocation: info.defaultLocation,
      icon: info.icon,
      environmentVariables:
        info.environmentVariables != null
          ? JSON.stringify([...info.environmentVariables])
          : '',
      preservedCommands: JSON.stringify(info.preservedCommands || []),
      initialInput: info.initialInput != null ? info.initialInput : '',
      trustToken,
    },
  });
  invariant(uri.startsWith(URI_PREFIX));
  return uri;
}

export function infoFromUri(
  paneUri: string,
  uriFromTrustedSource: boolean = false,
): TerminalInfo {
  const {query} = url.parse(paneUri, true);

  if (query == null) {
    return TERMINAL_DEFAULT_INFO;
  } else {
    const cwd = query.cwd === '' ? {} : {cwd: query.cwd};
    const command =
      query.command !== '' ? {command: JSON.parse(query.command)} : {};
    const title = query.title === '' ? {} : {title: query.title};
    const remainOnCleanExit = query.remainOnCleanExit === 'true';
    const key = query.key;
    const defaultLocation =
      query.defaultLocation != null && query.defaultLocation !== ''
        ? query.defaultLocation
        : TERMINAL_DEFAULT_LOCATION;
    const icon =
      query.icon != null && query.icon !== ''
        ? query.icon
        : TERMINAL_DEFAULT_ICON;
    const environmentVariables =
      query.environmentVariables != null && query.environmentVariables !== ''
        ? new Map(JSON.parse(query.environmentVariables))
        : new Map();
    const preservedCommands = JSON.parse(query.preservedCommands || '[]');
    const initialInput = query.initialInput != null ? query.initialInput : '';

    // Information that can affect the commands executed by the terminal,
    // and that therefore must come from a trusted source.
    //
    // If we detect that the URL did not come from this instance of Nuclide,
    // we just omit these fields so the user gets a default shell.
    const trustedFields: TerminalInfoTrustedFields = {
      ...cwd,
      ...command,
      environmentVariables,
      preservedCommands,
      initialInput,
    };

    // Everything here is cosmetic information that does not affect
    // processes running in the resulting terminal.
    const untrustedFields: TerminalInfoUntrustedFields = {
      ...title,
      remainOnCleanExit,
      defaultLocation,
      icon,
      key,
    };

    const isTrusted = uriFromTrustedSource || query.trustToken === trustToken;
    return {
      ...untrustedFields,
      ...(isTrusted ? trustedFields : {}),
    };
  }
}
