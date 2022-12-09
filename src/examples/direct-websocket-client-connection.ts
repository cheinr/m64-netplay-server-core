import WebSocket from 'ws';

/*
import {
  GameDirector,
  ConnectionInfo,
  AbstractClientConnection,
  IClientConnection
} from 'm64-netplay-server-core';
*/
import AbstractClientConnection from '../game/connections/abstract-client-connection';
import IClientConnection from '../game/connections/iclient-connection';
import ConnectionInfo from '../game/connections/connection-info';

let clientIdCounter = 0;

export default class DirectWebsocketClientConnection extends AbstractClientConnection implements IClientConnection {

  public readonly clientId: number = clientIdCounter++;

  private roomControlWS: WebSocket;
  private unreliableWS: WebSocket;
  private reliableWS: WebSocket;

  public constructor(connectionInfo: ConnectionInfo,
    bufferTarget: number) {
    super(connectionInfo, bufferTarget);
  }

  protected closeConnection() {
    if (this.roomControlWS) {
      this.roomControlWS.close();
    }

    if (this.unreliableWS) {
      this.unreliableWS.close();
    }

    if (this.reliableWS) {
      this.reliableWS.close();
    }
  }

  public setRoomControlSocket(ws: WebSocket) {
    this.roomControlWS = ws;

    ws.onmessage = (event: any) => {
      this._handleClientRoomControlMessage(event.data);
    };
  }

  public setReliableSocket(ws: WebSocket) {
    this.reliableWS = ws;

    ws.onmessage = (event: any) => {
      this._handleClientReliableMessage(event.data);
    };

    this.checkIfFullyConnected();
  }

  public setUnreliableSocket(ws: WebSocket) {
    this.unreliableWS = ws;

    ws.onmessage = (event: any) => {
      this._handleClientUnreliableMessage(event.data);
    };

    this.checkIfFullyConnected();
  }

  protected send(message: Buffer) {
    try {
      this.reliableWS.send(message);
    } catch (err) {
      console.error('Error while sending message [%o] to client: ', message, err);
    }
  }

  public sendUnreliable(message: ArrayBuffer): void {
    try {
      this.unreliableWS.send(message);
    } catch (err) {
      console.log(err);
    }
  }

  protected sendRoomControlMessage(message: string): void {
    this.roomControlWS.send(message);
  }

  private checkIfFullyConnected() {
    if (this.reliableWS && this.unreliableWS && this.roomControlWS) {
      this.onConnect();
    }
  }
}
