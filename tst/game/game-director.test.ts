import GameDirector, { ClientInfo } from '../../src/game/game-director';
//import ServerInfo from '../../src/game/server-info';
import IConnectionManager from '../../src/game/connections/iconnection-manager';
import ClientEmulationProgressManager from '../../src/game/client-emulation-progress-manager';
import CheckpointState from '../../src/game/checkpoint-state';
import IClientConnection from '../../src/game/connections/iclient-connection';
//import GameRoomIdentityInfo from '../../src/game/game-room-identity-info';
import RegistrationInfo from '../../src/game/registration-info';
import AbstractClientConnection from '../../src/game/connections/abstract-client-connection';
import EmulatorDataManager from '../../src/game/emulator-data-manager';

jest.mock('../../src/game/connections/iconnection-manager');
jest.mock('../../src/game/client-emulation-progress-manager', () => {
  return jest.fn().mockImplementation(() => {
    return {
      onClientDisconnect: jest.fn(() => ({ countsToResynchronizeOn: null })),
      start: jest.fn(),
      tryPause: jest.fn(),
      tryResume: jest.fn(),
      registerClient: jest.fn(),
      updateClientRegistrationInfo: jest.fn(),
      isPaused: jest.fn(() => true),
      getCurrentProgressCheckpointForClient: jest.fn(),
      getClientLag: jest.fn()
    }
  });
});

jest.mock('../../src/game/connections/iclient-connection', () => {
  return jest.fn().mockImplementation((connectionInfo) => {
    return {
      attachGameDirector: jest.fn(),
      sendRoomPlayerInfo: jest.fn(),
      sendGameStartMessage: jest.fn(() => Promise.resolve()),
      connectionInfo,
      sendPlayerLagNotification: jest.fn(() => Promise.resolve())
    }
  });
});

let clientIdCounter = 0;
class TestClientConnection extends AbstractClientConnection implements IClientConnection {

  gameDirector: GameDirector | undefined;
  public readonly clientId: number = clientIdCounter++;
  public readonly isGamepadConnected: boolean = false;

  disconnectPlayer = jest.fn();

  sendRoomPlayerInfo = jest.fn();

  sendGameStartMessage = jest.fn(async () => { });

  sendGamePauseMessage = jest.fn();

  sendGameResumeMessage = jest.fn();

  sendPlayerLagNotification = jest.fn(async () => { });

  closeConnection = jest.fn();

  send = jest.fn();

  sendUnreliable = jest.fn();
}

class TestConnectionManager implements IConnectionManager {
  connectionListeners: Function[] = [];
  disconnectListeners: Function[] = [];

  initialize(): Promise<void> {
    return null;
  }

  addConnectionListener(cb): void {
    this.connectionListeners.push(cb);
  };

  addDisconnectListener(cb): void {
    this.disconnectListeners.push(cb);
  };

  addClient(clientConnection: IClientConnection) {
    this.connectionListeners.forEach((cb) => cb(clientConnection));
  }

  removeClient(clientConnection: IClientConnection) {
    this.disconnectListeners.forEach((cb) => cb(clientConnection));
  }
}

let clientEmulationProgressManagerMock: ClientEmulationProgressManager;

let gameDirector: GameDirector;

let emulatorDataManager: EmulatorDataManager;

let testConnectionManager;

beforeEach(() => {

  (ClientEmulationProgressManager as jest.Mock).mockClear();

  clientEmulationProgressManagerMock = new ClientEmulationProgressManager();
  emulatorDataManager = new EmulatorDataManager();
  testConnectionManager = new TestConnectionManager();

  gameDirector = new GameDirector({
    emulatorDataManager,
    connectionManager: testConnectionManager,
    clientEmulationProgressManager: clientEmulationProgressManagerMock
  });

  gameDirector.runAsync();
});

test("AcceptConnection maps players to unused controllers if game has not yet started", (done) => {

  const clients = Array.from({ length: 4 }, (x, i) => i).map((key) => {
    const connectionInfo = {
      name: 'foo-' + key,
      token: 'bar-' + key
    }
    return new TestClientConnection(connectionInfo, 2);
  });

  clients.forEach((client) => {
    testConnectionManager.addClient(client);
  });

  setTimeout(() => {

    const client = clients[0];
    const sendRoomPlayerInfoCalls = (client.sendRoomPlayerInfo as jest.Mock).mock.calls;

    if (sendRoomPlayerInfoCalls[clients.length - 1]) {
      const playerInfoList = sendRoomPlayerInfoCalls[clients.length - 1][0];
      expect(playerInfoList.length).toBe(clients.length);

      clients.forEach((client, index) => {
        expect(playerInfoList[index].name).toBe(client.connectionInfo.name);
        expect(playerInfoList[index].mappedController).toBe(index + 1);
      });

      done();
    }
  }, 200);
});


test("Player starts game", (done) => {

  const playerInfo = {
    name: 'foo',
    token: 'bar'
  };
  const playerConnection = new TestClientConnection(playerInfo, 2);

  testConnectionManager.addClient(playerConnection);

  gameDirector.requestGameStart(playerInfo);

  expect(gameDirector.isGameStarted()).toBe(true);

  const expectedControllerToClientMappings = [playerInfo.token, null, null, null];
  expect(clientEmulationProgressManagerMock.start).toBeCalledWith(expectedControllerToClientMappings);

  setTimeout(() => {
    const sendGameStartMessageCalls = (playerConnection.sendGameStartMessage as jest.Mock).mock.calls;
    expect(sendGameStartMessageCalls.length).toBe(1);
    done();
  });
});

test("Player who joins after game start becomes a spectator", (done) => {

  const playerInfo = {
    name: 'foo',
    token: 'bar'
  };
  const playerConnection = new TestClientConnection(playerInfo, 2);

  const spectatorInfo = {
    name: 'spectator',
    token: 'spectatorToken'
  };

  const spectatorConnection = new TestClientConnection(spectatorInfo, 2);

  testConnectionManager.addClient(playerConnection);

  gameDirector.requestGameStart(playerInfo);
  expect(gameDirector.isGameStarted()).toBe(true);

  testConnectionManager.addClient(spectatorConnection);

  setTimeout(() => {

    const sendRoomPlayerInfoCalls = (playerConnection.sendRoomPlayerInfo as jest.Mock).mock.calls;
    const playerInfoList = sendRoomPlayerInfoCalls[1][0];
    expect(playerInfoList.length).toBe(2);

    console.log(playerInfoList);

    expect(playerInfoList[1].name).toBe(spectatorInfo.name);
    expect(playerInfoList[1].mappedController).toBe(-1);

    expect(playerInfoList[0].name).toBe(playerInfo.name);
    expect(playerInfoList[0].mappedController).toBe(1);

    done();
  });
});

test("sendGameRoomPlayerInfo uses checkpoint player/controller mappings if present ", (done) => {

  const playerInfo = {
    name: 'foo',
    token: 'bar'
  };
  const playerConnection = new TestClientConnection(playerInfo, 2);

  clientEmulationProgressManagerMock.getCurrentProgressCheckpointForClient = jest.fn(() => {
    return {
      pauseCounts: [0, 0, 0, 0],
      state: CheckpointState.RESUMED,
      clientsToSynchronizePauseFor: [],
      resumeTimeMillis: 0,
      controllerToClientMappings: [null, null, null, playerInfo.token]
    }
  });

  testConnectionManager.addClient(playerConnection);


  setTimeout(() => {

    const sendRoomPlayerInfoCalls = (playerConnection.sendRoomPlayerInfo as jest.Mock).mock.calls;

    const playerInfoList = sendRoomPlayerInfoCalls[sendRoomPlayerInfoCalls.length - 1][0];

    expect(playerInfoList.length).toBe(1);
    expect(playerInfoList[0].mappedController).toBe(4);
    done();
  }, 200);
});


test("P1 leaves Spectator stays", (done) => {

  const playerInfo = {
    name: 'foo',
    token: 'bar'
  };
  const playerConnection = new TestClientConnection(playerInfo, 2);

  const spectatorInfo = {
    name: 'spectator',
    token: 'spectatorToken'
  };

  const spectatorConnection = new TestClientConnection(spectatorInfo, 2);

  testConnectionManager.addClient(playerConnection);

  gameDirector.requestGameStart(playerInfo);
  expect(gameDirector.isGameStarted()).toBe(true);

  testConnectionManager.addClient(spectatorConnection);

  testConnectionManager.removeClient(playerConnection);

  setTimeout(() => {

    const sendRoomPlayerInfoCalls = (spectatorConnection.sendRoomPlayerInfo as jest.Mock).mock.calls;
    const playerInfoList = sendRoomPlayerInfoCalls[1][0];

    expect(playerInfoList[0].name).toBe(spectatorInfo.name);
    expect(playerInfoList[0].mappedController).toBe(-1);

    done();
  });
});

test("P1 leaves P2 stays after game starts", (done) => {

  const playerInfo = {
    name: 'foo',
    token: 'bar'
  };
  const player1Connection = new TestClientConnection(playerInfo, 2);

  const player2Info = {
    name: 'player2',
    token: 'player2Token'
  };

  const player2Connection = new TestClientConnection(player2Info, 2);

  testConnectionManager.addClient(player1Connection);
  testConnectionManager.addClient(player2Connection);

  gameDirector.requestGameStart(playerInfo);
  expect(gameDirector.isGameStarted()).toBe(true);

  testConnectionManager.removeClient(player1Connection);

  setTimeout(() => {

    const sendRoomPlayerInfoCalls = (player2Connection.sendRoomPlayerInfo as jest.Mock).mock.calls;
    const playerInfoList = sendRoomPlayerInfoCalls[1][0];

    expect(playerInfoList[0].name).toBe(player2Info.name);
    expect(playerInfoList[0].mappedController).toBe(2);

    done();
  });
});

test("GameDirector notifies ProgressManager of client disconnects", () => {

  const playerInfo = {
    name: 'foo',
    token: 'bar'
  };

  const playerInfo2 = Object.assign({}, playerInfo);
  const playerConnection = new TestClientConnection(playerInfo, 2);
  const playerConnection2 = new TestClientConnection(playerInfo2, 2);

  testConnectionManager.addClient(playerConnection);
  testConnectionManager.addClient(playerConnection2);

  testConnectionManager.removeClient(playerConnection);

  expect(clientEmulationProgressManagerMock.onClientDisconnect).toHaveBeenCalledWith(playerInfo.token);
});

test("Player resumes paused game", () => {

  const playerInfo = {
    name: 'foo',
    token: 'bar'
  };
  const playerConnection = new TestClientConnection(playerInfo, 2);

  testConnectionManager.addClient(playerConnection);

  gameDirector.requestGameStart(playerInfo);

  expect(gameDirector.isGameStarted()).toBe(true);

  const expectedControllerToClientMappings1 = [playerInfo.token, null, null, null];
  expect(clientEmulationProgressManagerMock.start).toBeCalledWith(expectedControllerToClientMappings1);

  gameDirector.requestGameResume(playerInfo);

  const expectedControllerToClientMappings2 = [
    playerInfo.token,
    null,
    null,
    null
  ];
  expect(clientEmulationProgressManagerMock.tryResume).toBeCalledWith(expectedControllerToClientMappings2);
});

test("registerPlayer adds registration Info to clientEmulationProgressManager", () => {

  const playerInfo = {
    name: 'foo',
    token: 'bar'
  };
  const playerConnection = new TestClientConnection(playerInfo, 2);

  const registrationInfo: RegistrationInfo = {
    registrationId: 1337,
    plugin: 0,
    useRawInput: false
  }
  testConnectionManager.addClient(playerConnection);

  gameDirector.registerPlayer(playerInfo, 0, registrationInfo);

  expect(clientEmulationProgressManagerMock.updateClientRegistrationInfo)
    .toHaveBeenCalledWith(playerInfo.token, registrationInfo);
});

test("reassignPlayer changes mappedController when game is paused", (done) => {

  const playerInfo = {
    name: 'foo',
    token: 'bar'
  };
  const playerConnection = new TestClientConnection(playerInfo, 2);

  testConnectionManager.addClient(playerConnection);

  gameDirector.requestGameStart(playerInfo);

  const newController = 3;

  gameDirector.reassignClientToController(playerInfo, playerConnection.clientId, newController);

  setTimeout(() => {

    const sendRoomPlayerInfoCalls = (playerConnection.sendRoomPlayerInfo as jest.Mock).mock.calls;

    console.log("sendRoomPlayerInfoCalls: %o", sendRoomPlayerInfoCalls);

    const playerInfoList = sendRoomPlayerInfoCalls[sendRoomPlayerInfoCalls.length - 1][0];

    console.log("playerInfoList1: %o", playerInfoList);

    expect(playerInfoList.length).toBe(1);
    expect(playerInfoList[0].mappedController).toBe(newController + 1);
    done();
  }, 200);
});

test("reasignPlayer doesn't allow p1 to be reassigned before game start", (done) => {

  const playerInfo = {
    name: 'foo',
    token: 'bar'
  };
  const playerConnection = new TestClientConnection(playerInfo, 2);

  testConnectionManager.addClient(playerConnection);

  const newController = 2;

  gameDirector.reassignClientToController(playerInfo, playerConnection.clientId, newController);

  setTimeout(() => {

    const sendRoomPlayerInfoCalls = (playerConnection.sendRoomPlayerInfo as jest.Mock).mock.calls;

    const playerInfoList = sendRoomPlayerInfoCalls[sendRoomPlayerInfoCalls.length - 1][0];

    console.log("playerInfoList: %o", playerInfoList);

    expect(playerInfoList.length).toBe(1);
    expect(playerInfoList[0].mappedController).toBe(1);
    done();
  }, 200);

});

