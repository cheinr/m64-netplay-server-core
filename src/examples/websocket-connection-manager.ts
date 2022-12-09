import WebSocket, { Server as WebSocketServer } from 'ws';
import IConnectionManager from '../game/connections/iconnection-manager';
import IClientConnection from '../game/connections/iclient-connection';
import DirectWebsocketConnection from './direct-websocket-client-connection';

interface Map<T> {
  [K: string]: T;
}

let CONNECTION_ID_COUNTER = 0;

export interface DirectWebsocketConnectionManagerInit {
  reliableWSS: WebSocketServer;
  unreliableWSS: WebSocketServer;
  roomControlWSS: WebSocketServer;
  bufferTarget: number;
};

export default class DirectWebsocketConnectionManager implements IConnectionManager {
  private readonly bufferTarget: number;

  private connections: Map<DirectWebsocketConnection> = {};

  private ws: WebSocket;
  private reliableWSS: WebSocketServer;
  private unreliableWSS: WebSocketServer;
  private roomControlWSS: WebSocketServer;

  private connectListeners: Function[];
  private disconnectListeners: Function[];

  public constructor({
    reliableWSS,
    unreliableWSS,
    roomControlWSS,
    bufferTarget,
  }: DirectWebsocketConnectionManagerInit) {
    this.bufferTarget = bufferTarget;

    this.connectListeners = [];
    this.disconnectListeners = [];

    this.ws;

    this._onClientConnect = this._onClientConnect.bind(this);
    this._onClientDisconnect = this._onClientDisconnect.bind(this);

    this.reliableWSS = reliableWSS;
    this.unreliableWSS = unreliableWSS;
    this.roomControlWSS = roomControlWSS;
  }

  private authenticate(req): DirectWebsocketConnection | null {

    console.log(req.url);

    const queryParams = req.url.split('?')[1].split('&');
    console.log(queryParams);

    let connectionId: string | undefined;
    let token: string | undefined;

    queryParams.forEach((queryParam: string) => {

      if (queryParam.includes('connectionId=')) {
        connectionId = queryParam.split('=')[1];
      }

      if (queryParam.includes('token=')) {
        token = queryParam.split('=')[1];
      }
    });

    if (connectionId === undefined) {
      return null;
    }

    const maybeConnection = this.connections[connectionId];

    if (maybeConnection && maybeConnection.connectionInfo.token === token) {
      return maybeConnection;
    } else {
      return null;
    }
  }

  public async initialize() {
    this.reliableWSS.on('connection', (ws, req) => {
      const maybeConnection = this.authenticate(req);

      if (maybeConnection) {
        maybeConnection.setReliableSocket(ws);
      } else {
        ws.close();
      }
    });

    this.unreliableWSS.on('connection', (ws, req) => {
      const maybeConnection = this.authenticate(req);

      if (maybeConnection) {
        maybeConnection.setUnreliableSocket(ws);
      } else {
        ws.close();
      }
    });

    this.roomControlWSS.on('connection', (ws, req) => {

      ws.on('message', (message: string) => {
        console.log('received: %o', message);

        const data = JSON.parse(message);


        if (data.type === 'request-game-join') {

          const playerInfo = data.payload.playerInfo;
          const connectionId = CONNECTION_ID_COUNTER++;
          const connection = new DirectWebsocketConnection(playerInfo, this.bufferTarget);

          connection.addConnectListener(this._onClientConnect);
          connection.addDisconnectListener(this._onClientDisconnect);

          connection.setRoomControlSocket(ws);

          this.connections[connectionId] = connection;

          ws.send(JSON.stringify({
            type: 'game-join-success',
            payload: {
              connectionId: connectionId
            }
          }));
        }
      });
    });
  }

  public addConnectionListener(cb: Function): void {
    this.connectListeners.push(cb);
  }

  public addDisconnectListener(cb: Function): void {
    this.disconnectListeners.push(cb);
  }

  private _onClientConnect(connection: IClientConnection): void {
    console.log('A player has finished connecting!');
    this.connectListeners.forEach(onConnect => onConnect(connection));
  }

  private _onClientDisconnect(connection: IClientConnection): void {
    delete this.connections[connection.getConnectionId()];
    this.disconnectListeners.forEach(listener => listener(connection));
  }
}
