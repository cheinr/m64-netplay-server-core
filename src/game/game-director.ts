import IClientConnection from './connections/iclient-connection';
import IConnectionManager from './connections/iconnection-manager';
import ConnectionInfo from './connections/connection-info';
import EmulatorDataManager from './emulator-data-manager';
import RegistrationInfo from './registration-info';
import ClientEmulationProgressManager from './client-emulation-progress-manager';
import CheckpointState from './checkpoint-state';

export interface ClientInfo {
  name: string;
  clientId: number;
  mappedController: number;
}

const GAME_HOST_CONNECTION_INDEX = 0;

export interface GameDirectorInit {
  connectionManager: IConnectionManager;
  clientEmulationProgressManager: ClientEmulationProgressManager;
  emulatorDataManager: EmulatorDataManager;
}

class GameDirector {

  private readonly connectionManager: IConnectionManager;
  private readonly emulatorDataManager: EmulatorDataManager;
  private readonly clientEmulationProgressManager: ClientEmulationProgressManager;
  private readonly clientConnections: IClientConnection[] = [];
  private readonly controllerToConnectionIndexMappings: (number | null)[] = [null, null, null, null];

  private gameStarted = false;

  public constructor({ connectionManager,
    clientEmulationProgressManager,
    emulatorDataManager }: GameDirectorInit) {

    this.connectionManager = connectionManager;
    this.clientEmulationProgressManager = clientEmulationProgressManager;
    this.emulatorDataManager = emulatorDataManager;
  }

  public async runAsync(): Promise<void> {

    const initializations: Promise<void>[] = [];

    initializations.push(this.connectionManager.initialize());

    return Promise.all(initializations).then(() => {
      console.log('initialized');

      this.connectionManager.addConnectionListener(this.acceptPlayerConnection.bind(this));
      this.connectionManager.addDisconnectListener(this.removePlayerConnection.bind(this));

    }).catch((err) => {
      console.log('Failed to initialize service: ' + err);
      throw err;
    });;
  }

  private acceptPlayerConnection(newClientConnection: IClientConnection): void {

    newClientConnection.attachGameDirector(this);
    this.clientConnections.push(newClientConnection);

    if (!this.isGameStarted()) {

      // Assign player to a controller if one is untaken
      const connectionIndex = this.clientConnections.findIndex((connection) => {
        return connection.connectionInfo.token === newClientConnection.connectionInfo.token;
      });

      const maybeFirstUntakenController = this.controllerToConnectionIndexMappings.findIndex(
        (mapping) => mapping === null);

      if (maybeFirstUntakenController !== -1) {
        this.controllerToConnectionIndexMappings[maybeFirstUntakenController] = connectionIndex;
      }
    } else {
      this.clientConnections.forEach((clientConnection) => {
        if (clientConnection.connectionInfo.token !== newClientConnection.connectionInfo.token) {
          const lag = this.clientEmulationProgressManager.getClientLag(clientConnection.connectionInfo.token);
          newClientConnection.sendPlayerLagNotification(clientConnection.clientId, lag).catch((err) => {
            console.error('Something went wrong while sending player lag notification to new connection!', err);
          });
        }
      });
    }

    const broadcastRoomClientInfoPromise = this.broadcastRoomClientInfo().catch((err) => {
      console.error('Something went wrong while accepting connection %o:', newClientConnection, err);
    });

    if (this.isGameStarted()) {
      broadcastRoomClientInfoPromise
        .then(async () => {

          const registrationId = this.clientEmulationProgressManager.registerClient(newClientConnection.connectionInfo.token);
          return newClientConnection.sendGameStartMessage(registrationId);
        })
        .catch((err) => {
          console.error('Something went wrong while accepting connection %o:', newClientConnection, err);
        });
    }
  }

  private removePlayerConnection(disconnectedClient: IClientConnection): void {
    console.log('We\'ve lost connection with %o', disconnectedClient.connectionInfo.name);

    const countsToResynchronizeOn = this.clientEmulationProgressManager
      .onClientDisconnect(disconnectedClient.connectionInfo.token)
      .countsToResynchronizeOn;

    if (countsToResynchronizeOn !== null) {
      this.resynchronizeClientPause(countsToResynchronizeOn);
    }

    const clientIndex = this.clientConnections.findIndex((clientConnection) => {
      return clientConnection && clientConnection.connectionInfo.token == disconnectedClient.connectionInfo.token;
    });

    if (clientIndex !== -1) {

      const connectionControllerMappings = this.controllerToConnectionIndexMappings.map((maybeConnectionId) => {
        if (maybeConnectionId !== null) {
          return this.clientConnections[maybeConnectionId];
        } else {
          return null;
        }
      });

      this.clientConnections.splice(clientIndex, 1);

      connectionControllerMappings.forEach((maybeConnection, index) => {
        if (maybeConnection) {
          const maybeNewIndex = this.clientConnections.findIndex((connection) => {
            return connection.connectionInfo.token === maybeConnection.connectionInfo.token;
          });

          if (maybeNewIndex !== -1) {
            this.controllerToConnectionIndexMappings[index] = maybeNewIndex;
          } else {
            this.controllerToConnectionIndexMappings[index] = null;
          }
        }
      });

      if (this.clientConnections.length === 0) {
        console.log('There are no more players connected. Shutting down...');
        this.shutdown();
      }

      this.broadcastRoomClientInfo().catch((err) => {
        console.log('Failed to broadcast room client info: ', err);
      });
    }
  }

  private resynchronizeClientPause(countsToResynchronizeOn: number[]): void {
    this.clientConnections.forEach((connection) => {

      const progressInfo = this.clientEmulationProgressManager.getClientProgressInfo(connection.connectionInfo.token);
      const isAtMaxCount = progressInfo.counts.every((pauseCount, index) => pauseCount === countsToResynchronizeOn[index]);

      if (!isAtMaxCount) {
        connection.sendGamePauseMessage(countsToResynchronizeOn).catch((err) => {
          console.error('Failed to send game pause message: ', err);
        });
      }
    });
  }

  public isGameStarted(): boolean {
    return this.gameStarted;
  }

  public isGamePaused(): boolean {
    return this.clientEmulationProgressManager.isPaused();
  }

  public hasClientsConnected(): boolean {
    return this.clientConnections.length > 0;
  }

  public requestGameStart(connectionInfo: ConnectionInfo): void {
    if (this.gameStarted) {
      return;
    }

    this.gameStarted = true;

    const controllerToClientMappings = this.controllerToConnectionIndexMappings.map((maybeConnectionIndex) => {
      if (maybeConnectionIndex !== null) {
        return this.clientConnections[maybeConnectionIndex]?.connectionInfo?.token;
      } else {
        return null;
      }
    });
    this.clientEmulationProgressManager.start(controllerToClientMappings);

    if (connectionInfo.token === this.clientConnections[GAME_HOST_CONNECTION_INDEX]?.connectionInfo.token) {

      this.clientConnections.forEach((clientConnection) => {

        if (clientConnection !== null) {
          const registrationId = this.clientEmulationProgressManager.registerClient(
            clientConnection.connectionInfo.token);

          clientConnection.sendGameStartMessage(registrationId).catch((err) => {
            console.error('Error while sending game start message: %o', err);
          });
        }
      });
    }
  }

  public confirmConnectionPaused(connectionInfo: ConnectionInfo, actualPauseCounts: number[]): void {

    const confirmPauseResult = this.clientEmulationProgressManager.confirmPause(connectionInfo.token,
      actualPauseCounts);

    if (confirmPauseResult.lag != null) {
      const clientConnection = this.getClientConnection(connectionInfo.token);

      if (clientConnection) {
        this.broadcastLagNotification(clientConnection.clientId, confirmPauseResult.lag).catch((err) => {
          console.error('Unexpected error while broadcasting client lag notification', err);
        });
      }
    }

    if (confirmPauseResult.clientCanInstantResume) {

      this.getClientConnection(connectionInfo.token)?.sendGameResumeMessage().catch((err) => {
        console.error('Failed to send game resume message for connection [%o]: ',
          connectionInfo,
          err);
      });
    }

    const countsToResynchronizeOn = confirmPauseResult.countsToResynchronizeOn;
    if (countsToResynchronizeOn !== null) {
      this.resynchronizeClientPause(countsToResynchronizeOn);
    } else {

      const clientConnection = this.getClientConnection(connectionInfo.token);
      if (clientConnection) {
        this.sendRoomClientInfo(clientConnection).catch((err) => {
          console.error('Failed to send room client info: ', err);
        });
      }
    }
  }

  public requestGamePause(connectionInfo: ConnectionInfo): void {
    if (!this.gameStarted) {
      return;
    }

    if (connectionInfo.token !== this.clientConnections[GAME_HOST_CONNECTION_INDEX]?.connectionInfo.token) {
      return;
    }

    const maybePauseTargets = this.clientEmulationProgressManager.tryPause();

    if (maybePauseTargets) {

      this.clientConnections.forEach((clientConnection) => {
        if (clientConnection !== null) {
          clientConnection.sendGamePauseMessage(maybePauseTargets).catch((err) => {
            console.error('Error while sending game pause message: %o', err);
          });
        }
      });
    }
  }

  public requestGameResume(connectionInfo: ConnectionInfo): void {

    if (!this.gameStarted) {
      return;
    }

    if (connectionInfo.token !== this.clientConnections[GAME_HOST_CONNECTION_INDEX]?.connectionInfo.token) {
      return;
    }

    const controllerToClientMappings = this.controllerToConnectionIndexMappings.map((maybeConnectionIndex) => {
      if (maybeConnectionIndex !== null) {
        return this.clientConnections[maybeConnectionIndex]?.connectionInfo?.token;
      } else {
        return null;
      }
    });
    const didResume = this.clientEmulationProgressManager.tryResume(controllerToClientMappings);

    if (didResume) {

      this.clientConnections.forEach((clientConnection) => {
        if (clientConnection !== null) {
          clientConnection.sendGameResumeMessage().catch((err) => {
            console.error('Error while sending game pause message: %o', err);
          });
        }
      });
    }
  }

  public reassignClientToController(connectionInfo: ConnectionInfo, clientId: number, desiredControllerIndex: number): void {
    // TODO
    if (this.gameStarted && !this.clientEmulationProgressManager.isPaused()) {
      return;
    }

    if (connectionInfo.token !== this.clientConnections[GAME_HOST_CONNECTION_INDEX]?.connectionInfo.token) {
      return;
    }

    const reassignedPlayerConnectionIndex = this.clientConnections.findIndex((clientConnection) => {
      return clientConnection.clientId === clientId;
    });

    if (reassignedPlayerConnectionIndex !== -1) {
      const clientConnection = this.clientConnections[reassignedPlayerConnectionIndex];

      // If the player's last checkpoint isn't in a PAUSED state we can assume they have
      // some catching up to do
      const checkpoint = this.clientEmulationProgressManager
        .getCurrentProgressCheckpointForClient(clientConnection.connectionInfo.token);
      if (checkpoint && CheckpointState.PAUSED !== checkpoint.state) {
        return;
      }
    }

    const maybePreviousClientIndexAssignedToDesiredController = desiredControllerIndex === -1
      ? null
      : this.controllerToConnectionIndexMappings[desiredControllerIndex];

    const currentNumberOfControllersPluggedIn = this.controllerToConnectionIndexMappings
      .filter((mapping) => mapping !== null)
      .length;

    if (desiredControllerIndex === -1 && currentNumberOfControllersPluggedIn <= 1) {
      return;
    }


    let previouslyAssignedController = -1;
    this.controllerToConnectionIndexMappings.forEach((connectionIndex: number, controllerIndex) => {
      if (connectionIndex === reassignedPlayerConnectionIndex) {
        previouslyAssignedController = controllerIndex;
      }
    });

    if (previouslyAssignedController === 0 && !this.gameStarted) {
      console.log('Can\'t reassign P1 before the game is started!');
      return;
    }

    // "Unplug" the player's previous controller
    if (previouslyAssignedController !== null) {
      this.controllerToConnectionIndexMappings[previouslyAssignedController] = null;
    }

    if (maybePreviousClientIndexAssignedToDesiredController !== null) {
      if (previouslyAssignedController !== -1) {
        this.controllerToConnectionIndexMappings[previouslyAssignedController] = maybePreviousClientIndexAssignedToDesiredController;
      }
    }

    this.controllerToConnectionIndexMappings[desiredControllerIndex] = reassignedPlayerConnectionIndex;

    this.broadcastRoomClientInfo().catch((err) => {
      console.error('Failed to broadcast RoomClientInfo: ', err);
    });
  }

  public saveSaveFile(name: string, fileData: Uint8Array): void {
    this.emulatorDataManager.saveSaveFile(name, fileData);
  }

  public async getSaveFile(name: string): Promise<Uint8Array> {
    return this.emulatorDataManager.getSaveFile(name);
  }

  public saveSettings(settingsData: Uint8Array): void {
    this.emulatorDataManager.saveSettings(settingsData);
  }

  public async getSettings(): Promise<Uint8Array> {
    return this.emulatorDataManager.getSettings();
  }

  public registerPlayer(connectionInfo: ConnectionInfo, playerNumber: number, registrationInfo: RegistrationInfo): boolean {

    let success: boolean;

    console.log('registerPlayer. playerNumber: %o, registrationInfo: %o', playerNumber, registrationInfo);

    const maybePlayerIndex = this.clientConnections.findIndex((connection) => {
      return connectionInfo.token === connection.connectionInfo.token;
    });

    if (maybePlayerIndex === -1) {
      throw `Unable to register player: No record of connection ${JSON.stringify(connectionInfo)} exists!`;
    }

    this.clientEmulationProgressManager.updateClientRegistrationInfo(
      connectionInfo.token,
      registrationInfo);

    if (playerNumber < 0 || playerNumber > 3) {
      // player is spectating; not much to do
      success = true;
    } else {

      // Actual connection mappings are set before emulator startup
      // Just making sure that matches with what the player is registering for
      if (this.controllerToConnectionIndexMappings[playerNumber] !== maybePlayerIndex) {
        console.error('Can\'t register player to controller they aren\'t already configured to use');
        success = false;
      } else {

        this.emulatorDataManager.registerPlayer(playerNumber, registrationInfo);

        success = true;
      }
    }

    return success;
  }

  public async waitForPlayersToRegister(connectionInfo: ConnectionInfo): Promise<(RegistrationInfo | null)[]> {
    return this.clientEmulationProgressManager
      .waitForPlayersToRegister(connectionInfo.token);
  }

  public disconnectPlayer(registrationId: number): void {

    const areNoPlayersLeft = this.emulatorDataManager.disconnectPlayer(registrationId);

    if (areNoPlayersLeft) {
      this.shutdown();
    }
  }

  public updateInput(connectionInfo: ConnectionInfo, count: number, keys: number, plugin: number): void {

    const playerNumber = this.clientEmulationProgressManager.getCurrentPlayerNumberForClient(connectionInfo.token);

    if (playerNumber === -1) {
      return;
    }

    const maybeInputMessage = this.emulatorDataManager.updateInput(playerNumber, count, keys, plugin);

    this.clientConnections.forEach((clientConnection) => {
      clientConnection.sendUnreliable(maybeInputMessage);
    });
  }

  public requestInput(
    connectionInfo: ConnectionInfo,
    registrationId: number,
    playerNumber: number,
    inputIndex: number,
    isSpectator: boolean,
    localBufferSize: number): ArrayBuffer | null {

    const updateProgressResult = this.clientEmulationProgressManager
      .updateProgress(connectionInfo.token, playerNumber, inputIndex);

    if (updateProgressResult.lag != null) {

      const clientConnection = this.getClientConnection(connectionInfo.token);

      if (clientConnection) {
        this.broadcastLagNotification(clientConnection.clientId, updateProgressResult.lag).catch((err) => {
          console.error('Unexpected error while broadcasting client lag notification', err);
        });
      }
    }

    if (updateProgressResult.countsToPauseOn) {
      console.log('Found a future pause checkpoint. Sending it to the player now!');
      this.getClientConnection(connectionInfo.token)?.sendGamePauseMessage(updateProgressResult.countsToPauseOn).catch((err) => {
        console.error('Failed to send game pause message: %o', err);
      });
    }

    return this.emulatorDataManager.requestInput(registrationId, playerNumber, inputIndex, isSpectator, localBufferSize);
  }

  public updatePlayerCp0Data(viCount: number, hashData: string): void {
    this.emulatorDataManager.updatePlayerCp0Data(viCount, hashData);
  }

  private getClientConnection(clientConnectionId: string): IClientConnection | null {
    return this.clientConnections.find((conn) => {
      return conn.connectionInfo.token === clientConnectionId;
    }) ?? null;
  }

  // TODO
  private shutdown(): void {
    process.exit();
  }

  public async broadcastRoomClientInfo(): Promise<void> {

    const sendRoomPlayerInfoPromises: Promise<void>[] = [];

    this.clientConnections.forEach((connection) => {
      sendRoomPlayerInfoPromises.push(this.sendRoomClientInfo(connection));
    });

    return Promise.all(sendRoomPlayerInfoPromises).then(() => { /* do nothing */ });
  }

  private getActiveControllerToConnectionIndexMappingsForConnection(
    clientConnection: IClientConnection): (null | number)[] {

    const maybeCurrentProgressInfo = this.clientEmulationProgressManager
      .getCurrentProgressCheckpointForClient(clientConnection.connectionInfo.token);

    let controllerToConnectionIndexMappings: (number | null)[];
    if (!maybeCurrentProgressInfo) {
      controllerToConnectionIndexMappings = this.controllerToConnectionIndexMappings;
    } else {

      const controllerToConnectionTokenMappings = maybeCurrentProgressInfo.controllerToClientMappings;

      if (controllerToConnectionTokenMappings) {
        controllerToConnectionIndexMappings = controllerToConnectionTokenMappings.map((mapping) => {
          if (mapping !== null) {

            const maybeClientConnectionIndexForToken = this.clientConnections.findIndex((clientConnection) => {
              return clientConnection.connectionInfo.token === mapping;
            });

            if (maybeClientConnectionIndexForToken !== -1) {
              return maybeClientConnectionIndexForToken;
            } else {
              return -1;
            }
          } else {
            return null;
          }
        });

      } else {
        controllerToConnectionIndexMappings = this.controllerToConnectionIndexMappings;
      }
    }

    return controllerToConnectionIndexMappings;
  }

  private async sendRoomClientInfo(clientConnection: IClientConnection): Promise<void> {

    const controllerToConnectionIndexMappings = this.getActiveControllerToConnectionIndexMappingsForConnection(clientConnection);

    const clientIndexToConnectedControllerMappings = {};

    controllerToConnectionIndexMappings.forEach((maybeConnectedClientIndex, controllerIndex) => {
      if (maybeConnectedClientIndex !== null && maybeConnectedClientIndex !== -1) {
        clientIndexToConnectedControllerMappings[maybeConnectedClientIndex] = controllerIndex;
      }
    });

    let clientPlayerIndex = -1;
    const clientInfoList: ClientInfo[] = this.clientConnections.map((playerConnection, index) => {

      if (playerConnection.connectionInfo.token === clientConnection.connectionInfo.token) {
        clientPlayerIndex = index;
      }

      let mappedController = -1;
      if (clientIndexToConnectedControllerMappings[index] !== undefined) {
        mappedController = clientIndexToConnectedControllerMappings[index] + 1;
      }

      return {
        name: playerConnection.connectionInfo.name,
        isGamepadConnected: playerConnection.isGamepadConnected,
        clientId: playerConnection.clientId,
        mappedController
      };
    });

    // Add entries for disconnected players
    controllerToConnectionIndexMappings.forEach((maybeMapping, index) => {
      if (maybeMapping === -1) {
        clientInfoList.push({
          name: '<disconnected>',
          clientId: -1,
          mappedController: index + 1
        });
      }
    });


    return clientConnection.sendRoomPlayerInfo(clientInfoList, clientPlayerIndex);
  }

  private async broadcastLagNotification(clientId: number, lag: number): Promise<void> {
    const sendRoomPlayerInfoPromises: Promise<void>[] = [];

    this.clientConnections.forEach((connection) => {
      sendRoomPlayerInfoPromises.push(connection.sendPlayerLagNotification(clientId, lag));
    });

    return Promise.all(sendRoomPlayerInfoPromises).then(() => { /* do nothing */ });
  }
}

export default GameDirector;
