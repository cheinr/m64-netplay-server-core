import GameDirector, { ClientInfo } from '../game-director';

//eslint-disable-next-line @typescript-eslint/interface-name-prefix
export default interface IClientConnection {

  readonly connectionInfo: { name: string; token: string };
  readonly clientId: number;
  readonly isGamepadConnected: boolean;

  attachGameDirector(gameDirector: GameDirector): void;

  getConnectionId(): string;

  addConnectListener(cb: Function): void;
  addDisconnectListener(cb: Function): void;

  sendUnreliable(arrayBuffer: ArrayBuffer | null): void;
  sendGameStartMessage(registrationId: number): Promise<void>;
  sendGamePauseMessage(countsToResynchronizeOn: number[]): Promise<void>;
  sendGameResumeMessage(): Promise<void>;
  sendRoomPlayerInfo(clientInfoList: ClientInfo[], clientPlayerIndex: number): void;
  sendPlayerLagNotification(clientId: number, lag: number): Promise<void>;

}; //eslint-disable-line semi
