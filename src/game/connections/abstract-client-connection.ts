import * as XXH from 'xxhashjs';

import GameDirector from '../game-director';
import RegistrationInfo from '../registration-info';

export interface ConnectionInfo {
  name: string;
  token: string;
}

/* eslint @typescript-eslint/no-non-null-assertion: 0 */
export default abstract class AbstractClientConnection {

  public readonly connectionInfo: { name: string; token: string };

  protected abstract gameDirector: GameDirector | undefined;

  private registrationInfo: RegistrationInfo | null;

  private readonly connectListeners: Function[] = [];
  private readonly disconnectListeners: Function[] = [];
  private readonly clientReadyListeners: Function[] = [];

  private readonly bufferTarget: number;

  private isClosed = false;
  private clientIsReady = false;

  protected abstract send(buffer: Buffer): void;
  public abstract sendUnreliable(buffer: ArrayBuffer): void;
  protected abstract closeConnection(): void;

  public constructor(connectionInfo: ConnectionInfo,
    bufferTarget: number) {

    this.bufferTarget = bufferTarget;
    this.connectionInfo = connectionInfo;
  }

  public attachGameDirector(gameDirector: GameDirector): void {
    this.gameDirector = gameDirector;
  }

  public getRegistrationInfo(): RegistrationInfo | null {
    return this.registrationInfo;
  }

  public getConnectionId(): string {
    return this.connectionInfo.token;
  }

  public addConnectListener(cb: Function): void {
    this.connectListeners.push(cb);
  }

  public addDisconnectListener(cb: Function): void {
    this.disconnectListeners.push(cb);
  }

  private registerPlayer(playerNumber: number,
    plugin: number,
    useRawInput: boolean,
    registrationId: number): void {

    const registrationInfo: RegistrationInfo = {
      plugin,
      useRawInput,
      registrationId
    };

    this.registrationInfo = registrationInfo;
    const success = this.gameDirector!.registerPlayer(this.connectionInfo, playerNumber, registrationInfo);

    const response = new Uint8Array(2);
    response[0] = success ? 1 : 0;

    response[1] = this.bufferTarget;

    console.log('Sending registerPlayer response: %o', response);
    this.send(Buffer.from(response));
  }

  private async sendPlayerRegistrationData(): Promise<void> {

    const playerRegistrationInfo = await this.gameDirector!.waitForPlayersToRegister(this.connectionInfo);


    const output = new Uint8Array(24);

    console.log('Players: %o', playerRegistrationInfo);

    for (let i = 0; i < 4; i++) {

      const playerData = Buffer.from(new Uint8Array(6));

      const registrationData = playerRegistrationInfo[i];
      if (registrationData) {

        playerData.writeUInt32BE(registrationData.registrationId, 0);
        playerData.writeUInt8(registrationData.plugin, 4);
        playerData.writeUInt8(registrationData.useRawInput ? 1 : 0, 5);

      } else {
        playerData.fill(0);
      }

      output.set(playerData, i * 6);
    }

    console.log('Sending player registration data: %o', output);

    this.send(Buffer.from(output));
  }

  private notifyDisconnect(registrationId: number): void {
    this.gameDirector!.disconnectPlayer(registrationId);
  }

  protected _handleClientReliableMessage(data: Buffer): void {

    const messageType = data[0];

    if (messageType === 1) { // Send Save File

      console.log('Received SaveFile Request: %o', data);

      const nameEnd = data.indexOf(0) + 1;
      const nameBytes = data.slice(1, nameEnd);

      const name = String.fromCharCode.apply(null, nameBytes);

      const fileData = data.slice(nameEnd + 4, data.length);

      this.saveSaveFile(name, fileData);

    } else if (messageType === 2) { // Request Save File


      const nameBytes = data.slice(1);

      const name = String.fromCharCode.apply(null, nameBytes);
      console.log('Received SendSaveFile Request for file: %o', name);

      this.sendSaveFile(name);

    } else if (messageType === 3) { // Send Settings

      console.log('Received Settings Request: %o', data);

      const settingsBytes = data.slice(1, 24);

      this.saveSettings(settingsBytes);

    } else if (messageType === 4) { // Request Settings

      console.log('Received SendSettings Request: %o', data);
      this.sendSettings();

    } else if (messageType === 5) { // Player Registration Request
      console.log('Received Player Registration Request: %o', data);

      const buff = Buffer.from(data);

      const playerNum: number = buff.readUInt8(1);
      const plugin: number = buff.readUInt8(2);
      const useRawInput: boolean = data[3] === 0 ? false : true;
      const registrationId: number = buff.readUInt32BE(4);

      console.log('Registering player: %o, with plugin %o and registrationId: %o', playerNum, plugin, registrationId);

      this.registerPlayer(playerNum, plugin, useRawInput, registrationId);

    } else if (messageType === 6) { // Request player registration data

      console.log('Received RequestPlayerRegistration Request: %o', data);

      this.sendPlayerRegistrationData().catch((err) => {
        console.error('Exception while sending player registration data: ', err);
      });

    } else if (messageType === 7) { // Player Disconnection Notice

      console.log('Received Player Disonnect notice: %o', data);
      const buff = Buffer.from(data);
      const registrationId: number = buff.readUInt32BE(0);

      this.notifyDisconnect(registrationId);
    } else {

      console.log('Received unknown message: %o', messageType);
    }
  }

  protected _handleClientUnreliableMessage(data: Buffer): void {

    const messageType = data[0];

    if (messageType === 0) { // Key Input Data

      const buff = Buffer.from(data);

      const count = buff.readUInt32BE(2);
      const keys = buff.readUInt32BE(6);
      const plugin = buff.readUInt8(10);

      this.updateInput(count, keys, plugin);

    } else if (messageType === 2) { // Request Input for a Player

      const buff = Buffer.from(data);
      const playerNumber = buff.readUInt8(1);
      const registrationId = buff.readUInt32BE(2);

      const inputIndex = buff.readUInt32BE(6);
      const isSpectator = buff.readUInt8(10) === 0 ? false : true;
      const localBufferSize = buff.readUInt8(11);

      try {
        const inputBuffer: ArrayBuffer = this.requestInput(
          registrationId,
          playerNumber,
          inputIndex,
          isSpectator,
          localBufferSize);

        if (inputBuffer.byteLength > 5) {
          this.sendUnreliable(inputBuffer);
        }
      } catch (err) {
        console.log(err);
      }

    } else if (messageType === 4) { // Client Sync Data

      const buff = Buffer.from(data);
      const viCount = buff.readUInt32BE(1);

      const hashData = buff.slice(5, 133);

      const hash = XXH.h64(hashData);

      this.updatePlayerCp0Data(viCount, hash.toString());
    } else {
      console.log('Unknown packet type: %o', data[0]);
    }
  }

  private updatePlayerCp0Data(viCount: number, hashData: string): void {
    this.gameDirector!.updatePlayerCp0Data(viCount, hashData);
  }

  private requestInput(registrationId: number,
    playerNumber: number,
    inputIndex: number,
    isSpectator: boolean,
    localBufferSize: number): ArrayBuffer {


    const maybeInputBuffer = this.gameDirector!.requestInput(
      this.connectionInfo,
      registrationId,
      playerNumber,
      inputIndex,
      isSpectator,
      localBufferSize);

    if (maybeInputBuffer === null) {

      this.closeConnection();
      this.notifyDisconnect(registrationId);

      throw `Error: requested input ${inputIndex} for player $playerNumber} is not available`;
    }

    return maybeInputBuffer;
  }

  private updateInput(count: number, keys: number, currentPlugin: number): void {

    this.gameDirector!.updateInput(this.connectionInfo, count, keys, currentPlugin);
  }

  protected onConnect(): void {
    this.connectListeners.forEach((cb) => cb(this));
  }

  protected onDisconnect(): void {
    if (!this.isClosed) {
      this.isClosed = true;
      this.disconnectListeners.forEach((cb) => cb(this));
    }
  }

  private saveSaveFile(name: string, fileData: Uint8Array): void {
    this.gameDirector!.saveSaveFile(name, fileData);
  }

  private sendSaveFile(name: string): void {

    this.gameDirector!.getSaveFile(name).then((saveFileData) => {
      console.log('Sending save file data: %o', saveFileData);
      this.send(Buffer.from(saveFileData));
    }).catch((err) => {
      console.log('Unexpected exception while sending save file data %s: %o', name, err);
    });
  }

  private saveSettings(settingsData: Uint8Array): void {
    this.gameDirector!.saveSettings(settingsData);
  }

  private sendSettings(): void {

    this.gameDirector!.getSettings().then((settingsData: Uint8Array) => {
      console.log('sending settings: %o', settingsData);
      this.send(Buffer.from(settingsData));
    }).catch((err) => {
      console.log('Unexpected exception while sending settings data: %o', err);
      throw err;
    });
  }

  protected async _waitForClientToBeReady(): Promise<void> {
    return new Promise((res) => {
      if (this.clientIsReady) {
        res();
      } else {
        this.clientReadyListeners.push(res);
      }
    });
  }

  protected signalClientReady(): void {
    this.clientIsReady = true;
    this.clientReadyListeners.forEach((cb) => cb());
  }
}
