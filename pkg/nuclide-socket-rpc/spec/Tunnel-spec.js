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

import * as Tunnel from '../lib/Tunnel';
import {ConnectionFactory} from '../lib/Connection';
import net from 'net';
import invariant from 'assert';
import {ConnectableObservable} from 'rxjs';
import {getLogger} from 'log4js';

import type {SocketEvent} from '../lib/types.js';

const TEST_PORT = 5004;
const cf = new ConnectionFactory();

describe('createTunnel', () => {
  let td;

  beforeEach(() => {
    getLogger('SocketService-spec').debug('--SPEC START--');
    td = {
      to: {
        host: 'localhost',
        port: TEST_PORT + 1,
        family: 6,
      },
      from: {
        host: 'localhost',
        port: TEST_PORT,
        family: 6,
      },
    };
  });

  afterEach(() => {
    getLogger('SocketService-spec').debug('--SPEC END--');
  });

  it('should set up a listener that a client can connect to', done => {
    const events = Tunnel.createTunnel(td, new ConnectionFactory());
    let serverListening = false;
    let subscription;

    waitsForPromise(async () => {
      await new Promise(resolve => {
        subscription = events.refCount().subscribe({
          next: event => {
            if (event.type === 'server_started') {
              serverListening = true;
              resolve();
            }
          },
        });
      });
    });

    waitsForPromise(async () => {
      expect(serverListening).toBe(true);
      await testConnectability(TEST_PORT);
      subscription.unsubscribe();
      invariant(done);
      done();
    });
  });

  it('should return a ConnectableObservable that emits listener events', done => {
    const events: ConnectableObservable<SocketEvent> = Tunnel.createTunnel(
      td,
      cf,
    );
    const eventList = [];
    let types;

    const subscription = events.refCount().subscribe({
      next: event => {
        eventList.push(event);
      },
    });

    waitsForPromise(async () => {
      await testConnectability(TEST_PORT);
      subscription.unsubscribe();
      types = eventList.map(event => event.type);
      expect(types).toContain('server_started');
      expect(types).toContain('client_connected');
      expect(types).toContain('client_disconnected');
      invariant(done);
      done();
    });
  });

  it('should send replies back to the originating client', done => {
    const message = 'HELLO WORLD';
    let response = null;
    let echoServer;

    // start echo server
    waitsForPromise(async () => {
      echoServer = net.createServer(socket => {
        socket.pipe(socket);
      });
      await new Promise(resolve => {
        echoServer.listen({host: '::', port: TEST_PORT + 1}, resolve);
      });
    });

    // create tunnel
    const subscription = Tunnel.createTunnel(td, cf)
      .refCount()
      .subscribe();

    // create connection and send data
    waitsForPromise(async () => {
      await new Promise(resolve => {
        const socket = net.createConnection(TEST_PORT, () => {
          socket.on('data', data => {
            response = data.toString();
            resolve();
          });
          socket.write(new Buffer(message));
        });
      });
    });

    runs(() => {
      expect(message).toEqual(response);
      subscription.unsubscribe();
      invariant(done);
      echoServer.close(done);
    });
  });

  it('should error if the port is already bound', done => {
    let subscription = null;
    waitsForPromise(async () => {
      await new Promise(resolve => {
        subscription = Tunnel.createTunnel(td, cf)
          .refCount()
          .subscribe({next: resolve});
      });
    });

    waitsForPromise({shouldReject: true}, async () => {
      const failing = Tunnel.createTunnel(td, cf).refCount();
      await failing.toPromise();
    });

    runs(() => {
      invariant(subscription);
      subscription.unsubscribe();
      invariant(done);
      done();
    });
  });

  it('should stop listening when the observable is unsubscribed', () => {
    waitsForPromise(async () => {
      const observable = Tunnel.createTunnel(td, cf);

      await new Promise(resolve => {
        const subscription = observable
          .refCount()
          .take(1)
          .subscribe({
            next: event => {
              resolve(event);
              subscription.unsubscribe();
            },
          });
      });
    });

    waitsForPromise({shouldReject: true}, async () => {
      await testConnectability(TEST_PORT);
    });
  });

  it('should allow for multiple clients to connect and interact', done => {
    let toServer;
    const sockets: Array<net.Socket> = [];
    let subscription = null;

    // create the 'to' server
    waitsForPromise(async () => {
      await new Promise(resolve => {
        toServer = net.createServer(socket => {
          socket.pipe(socket);
        });
        toServer.listen({host: '::', port: TEST_PORT + 1}, resolve);
      });
    });

    waitsForPromise(async () => {
      await new Promise(resolve => {
        subscription = Tunnel.createTunnel(td, cf)
          .refCount()
          .subscribe({next: resolve});
      });
    });

    waitsForPromise(async () => {
      await new Promise(resolve => {
        sockets.push(net.createConnection(TEST_PORT, resolve));
      });
    });

    waitsForPromise(async () => {
      await new Promise(resolve => {
        sockets.push(net.createConnection(TEST_PORT, resolve));
      });
    });

    waitsForPromise(async () => {
      await new Promise(resolve => {
        sockets.forEach((socket, index) => {
          socket.on('data', data => {
            expect(data.toString()).toEqual('data' + index);
          });
          socket.write(new Buffer('data' + index));
        });
        resolve();
      });
    });

    runs(() => {
      invariant(subscription);
      subscription.unsubscribe();
      toServer.close(done);
    });
  });

  it('should handle clients that error out', done => {
    let subscription = null;
    let toServer;

    // create the 'to' server
    waitsForPromise(async () => {
      await new Promise(resolve => {
        toServer = net.createServer(socket => {
          socket.pipe(socket);
        });
        toServer.listen({host: '::', port: TEST_PORT + 1}, resolve);
      });
    });

    waitsForPromise(async () => {
      await new Promise(resolve => {
        subscription = Tunnel.createTunnel(td, cf)
          .refCount()
          .subscribe({next: resolve});
      });
    });

    waitsForPromise(async () => {
      await new Promise(resolve => {
        const socket = net.createConnection(TEST_PORT, () => {
          socket.destroy(new Error('boom'));
          resolve();
        });
        socket.on('error', () => {});
      });
    });

    runs(() => {
      invariant(subscription);
      subscription.unsubscribe();
      toServer.close(done);
    });
  });
});

async function testConnectability(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port);
    socket.on('error', err => reject(err));
    invariant(socket);
    socket.on('connect', async () => {
      socket.write(new Buffer('hello world'));
      socket.on('end', () => resolve());
      socket.end();
    });
  });
}
