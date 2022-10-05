import RegistrationInfo from './registration-info';

interface Input {
  keys: number;
  currentPlugin: number;
}

interface BasicMap<T> {
  [K: string]: T;
}

interface KeepaliveInfo {
  keepalive: number;
  playerNumber: number;
}

const MAX_COUNT_LAG = 864000;

class EmulatorDataManager {

  private readonly saveFiles: Map<string, Uint8Array> = new Map();
  private readonly playerKeepalives: Map<number, KeepaliveInfo> = new Map();
  private readonly bufferHealth: number[] = [-1, -1, -1, -1];
  private readonly inputDelays: number[] = [-1, -1, -1, -1];
  private readonly leadCount: number[] = [0, 0, 0, 0];
  private readonly inputs: BasicMap<Input>[] = [{}, {}, {}, {}];
  private readonly syncHash: Map<number, string> = new Map();
  private readonly bufferSize: number[] = [3, 3, 3, 3];
  private readonly bufferTarget: number = 2;

  private readonly buttons: Input[][] = [[], [], [], []];
  private readonly onSaveFileReceivedListeners: BasicMap<((data: Uint8Array) => void)[]> = {};
  private readonly onSettingsReceivedListeners: ((data: Uint8Array) => void)[] = [];

  private settings: Uint8Array;
  private status = 0;
  private gamePaused = false;

  private udpTimerInterval: NodeJS.Timer | null = null;


  public setGameIsPaused(isPaused: boolean): void {
    this.gamePaused = isPaused;
  }

  public saveSaveFile(name: string, fileData: Uint8Array): void {
    this.saveFiles.set(name, fileData);

    if (this.onSaveFileReceivedListeners[name]) {
      this.onSaveFileReceivedListeners[name].forEach((listener) => {
        listener(fileData);
      });

      delete this.onSaveFileReceivedListeners[name];
    }
  }

  public async getSaveFile(name: string): Promise<Uint8Array> {
    console.log('saveFiles: %o', this.saveFiles);
    const saveFileData = this.saveFiles.get(name);

    if (saveFileData) {
      return saveFileData;
    } else {

      return new Promise((resolve, reject) => {

        if (!this.onSaveFileReceivedListeners[name]) {
          this.onSaveFileReceivedListeners[name] = [];
        }

        this.onSaveFileReceivedListeners[name].push((data) => {
          resolve(data);
        });

        setTimeout(() => {
          reject('Timed out waiting for save file from p1');
        }, 15000);
      });
    }
  }

  public saveSettings(settingsData: Uint8Array): void {
    this.settings = settingsData;

    this.onSettingsReceivedListeners.forEach((listener) => {
      listener(this.settings);
    });

    this.onSettingsReceivedListeners.length = 0;
  }

  public async getSettings(): Promise<Uint8Array> {
    if (this.settings) {
      return this.settings;
    } else {

      return new Promise((resolve, reject) => {

        this.onSettingsReceivedListeners.push((settingsData) => {
          resolve(settingsData);
        });

        setTimeout(() => {
          reject('Timed out waiting for settings from p1');
        }, 15000);
      });
    }
  }

  public registerPlayer(playerNumber: number, registrationInfo: RegistrationInfo): void {
    // 'udpServer' stuff
    this.playerKeepalives[registrationInfo.registrationId] = {
      keepalive: 0,
      playerNumber
    };

    let plugin = registrationInfo.plugin;
    if (playerNumber > 0 && plugin == 2) { // Only P1 can use mempak
      plugin = 1;
    }

    this.inputs[playerNumber][0] = {
      keys: 0,
      currentPlugin: plugin
    };

    if (!this.udpTimerInterval) {
      this.udpTimerInterval = setInterval(() => {
        this.tick();
      }, 500);
    }
  }

  private tick(): void {
    for (let i = 0; i < 4; i++) {
      if (this.bufferHealth[i] != -1) {

        if (this.bufferHealth[i] > this.bufferTarget && this.bufferSize[i] > 0) {
          this.bufferSize[i]--;
        } else if (this.bufferHealth[i] < this.bufferTarget) {
          this.bufferSize[i]++;
        }
      }
    }

    if (!this.gamePaused) {
      let shouldDelete: string | null = null;

      Object.keys(this.playerKeepalives).forEach((playerRegistrationId) => {

        const playerKeepalive = this.playerKeepalives[playerRegistrationId];

        playerKeepalive.keepalive++;
        if (playerKeepalive.keepalive > 40) {
          shouldDelete = playerRegistrationId;
        }
      });

      // TODO - This doesn't seem right with the loop right above
      if (shouldDelete) {
        this.disconnectPlayer(shouldDelete);
      }
    }
  }


  public disconnectPlayer(registrationId: number): boolean {

    if (!(registrationId in this.playerKeepalives)) {
      const areNoPlayersLeft = Object.values(this.playerKeepalives).length <= 0;
      return areNoPlayersLeft;
    }

    const playerNumber = this.playerKeepalives[registrationId].playerNumber;
    console.log('Player: %s has disconnected', playerNumber + 1);

    this.status |= (0x1 << (playerNumber + 1));

    delete this.playerKeepalives[registrationId];

    const areNoPlayersLeft = Object.values(this.playerKeepalives).length <= 0;
    return areNoPlayersLeft;
  }

  public updateInput(playerNumber: number, count: number, keys: number, plugin: number): ArrayBuffer | null {

    if (this.inputDelays[playerNumber] >= 0) {
      this.doUpdateInput(playerNumber,
        count + this.inputDelays[playerNumber],
        keys,
        plugin);
    } else if (this.buttons[playerNumber].length === 0) {

      this.buttons[playerNumber].push({
        keys,
        currentPlugin: plugin
      });

    }

    return this.getInput(playerNumber, count, true);
  }

  public requestInput(registrationId: number, playerNumber: number, inputIndex: number, isSpectator: boolean, localBufferSize: number): ArrayBuffer | null {


    if (registrationId in this.playerKeepalives) {
      this.playerKeepalives[registrationId].keepalive = 0;
    }

    if (inputIndex >= this.leadCount[playerNumber] && !isSpectator) {

      if (!isSpectator) {
        this.bufferHealth[playerNumber] = localBufferSize;
        this.leadCount[playerNumber] = inputIndex;
      }
    }

    const countLag = this.leadCount[playerNumber] - inputIndex;

    if (countLag >= MAX_COUNT_LAG) {
      // The input isn't around and never will be again.
      return null;
    }

    return this.getInput(playerNumber, inputIndex, isSpectator);
  }

  private getInput(playerNumber: number, count: number, isSpectator: boolean): ArrayBuffer {

    const buffer = Buffer.from(new Uint8Array(512));
    const countLag = this.leadCount[playerNumber] - count;

    buffer[0] = 1;
    buffer[1] = playerNumber;
    buffer[2] = this.status;
    buffer[3] = countLag;

    let currentByte = 5;
    const start = count;
    let end = start + this.bufferSize[playerNumber];

    let inputIndex = count;

    while ((currentByte < 500) && ((isSpectator === false && countLag === 0 && (inputIndex < end)) || this.inputs[playerNumber][inputIndex] !== undefined)) {

      buffer.writeUInt32BE(inputIndex, currentByte);
      currentByte += 4;

      if (!this.checkIfExists(playerNumber, inputIndex)) {
        end = inputIndex - 1;
        continue;
      }

      buffer.writeUInt32BE(this.inputs[playerNumber][inputIndex].keys, currentByte);
      currentByte += 4;
      buffer.writeUInt8(this.inputs[playerNumber][inputIndex].currentPlugin, currentByte);
      currentByte += 1;

      //TODO ?
      inputIndex++;

    }

    buffer[4] = inputIndex - start;

    return buffer;
  }

  private checkIfExists(playerNumber: number, count: number): boolean {

    const inputExists: boolean = this.inputs[playerNumber][count] !== undefined;

    if (count > MAX_COUNT_LAG && (count - MAX_COUNT_LAG) in this.inputs[playerNumber]) {
      delete this.inputs[playerNumber][count - MAX_COUNT_LAG];
    }

    if (this.inputDelays[playerNumber] < 0 && !inputExists) {

      if (this.buttons[playerNumber].length > 0) {

        this.inputs[playerNumber][count] = this.buttons[playerNumber][0];
        this.buttons[playerNumber].splice(0, 1);
      } else if ((count - 1) in this.inputs[playerNumber]) {

        this.inputs[playerNumber][count] = this.inputs[playerNumber][count - 1];
      } else {

        // No controller present
        this.inputs[playerNumber][count] = {
          keys: 0,
          currentPlugin: 0
        };
      }

      return true;
    } else {


      return inputExists;
    }
  }

  private doUpdateInput(playerNumber: number, count: number, keys: number, plugin: number): void {
    const previousCount = count - 1;

    this.inputs[playerNumber][count] = { keys, currentPlugin: plugin };


    /* The recursion here covers two situations:
     *
     * 1. The count < inputDelay, so we need to populate the first frames
     * 2. We lost a udp packet, or received them out of order.
     */
    if (previousCount == 0 || (previousCount > 0 && !this.inputs[playerNumber][previousCount]))
      this.doUpdateInput(playerNumber, previousCount, keys, plugin);
  }

  public updatePlayerCp0Data(viCount: number, hashData: string): void {

    if ((this.status & 1) == 0) {
      if (!this.syncHash[viCount]) {
        if (this.syncHash.entries.length > 500) {
          this.syncHash.clear();
        }

        this.syncHash[viCount] = hashData;
      } else if (this.syncHash[viCount] !== hashData) {

        this.status |= 1;

        // TODO
        console.log('Room desynced!');
      }
    }
  }

  public getLeadCounts(): number[] {
    return Object.assign([], this.leadCount);
  }
}

export default EmulatorDataManager;
