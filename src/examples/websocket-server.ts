import { createServer } from 'http';
import { parse } from 'url';
import { Server as WebSocketServer } from 'ws';

/*
import {
  GameDirector,
  ClientEmulationProgressManager,
  EmulatorDataManager
} from 'm64-netplay-server-core';
*/
import GameDirector from '../game/game-director';
import ClientEmulationProgressManager from '../game/client-emulation-progress-manager';
import EmulatorDataManager from '../game/emulator-data-manager';

import DirectWebsocketConnectionManager from './websocket-connection-manager';

async function startAsync(): Promise<void> {

  const clientEmulationProgressManager = new ClientEmulationProgressManager();
  const emulatorDataManager = new EmulatorDataManager();

  const bufferTarget = 2;

  const server = createServer();
  const reliableWSS = new WebSocketServer({ noServer: true });
  const unreliableWSS = new WebSocketServer({ noServer: true });
  const roomControlWSS = new WebSocketServer({ noServer: true });

  server.on('upgrade', function upgrade(request, socket, head): void {
    const { pathname } = parse(request.url);

    console.log('upgrade: %o', request);

    if (pathname?.includes('/reliable')) {

      reliableWSS.handleUpgrade(request, socket, head, function done(ws): void {
        reliableWSS.emit('connection', ws, request);
      });
    } else if (pathname?.includes('/unreliable')) {

      unreliableWSS.handleUpgrade(request, socket, head, function done(ws): void {
        unreliableWSS.emit('connection', ws, request);
      });
    } else if (pathname?.includes('/room-control')) {

      roomControlWSS.handleUpgrade(request, socket, head, function done(ws): void {
        roomControlWSS.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  server.listen(2525);

  const connectionManager = new DirectWebsocketConnectionManager({
    reliableWSS,
    unreliableWSS,
    roomControlWSS,
    bufferTarget
  });

  const gameServer = new GameDirector({
    connectionManager,
    clientEmulationProgressManager,
    emulatorDataManager
  });

  return gameServer.runAsync();
};


startAsync().then(() => {
  console.log('Game Server initialized successfully');
  if (process.send) {
    process.send(JSON.stringify({
      initialized: true
    }));
  }
}).catch((err) => {
  console.error('Unexpected error while initializing gameServer', err);
  process.exit(1);
});
